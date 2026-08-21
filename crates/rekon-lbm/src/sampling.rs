use glam::Vec3;
use rekon_geometry::{Aabb, Mesh, VoxelGrid};

use crate::lattice::{Lattice, CS2};

/// Freestream reference density for `Cp`, measured from the SOLVED field
/// (median density over fluid cells) rather than assumed equal to the
/// nominal initial `rho0`.
///
/// This is required, not a refinement. `boundary::apply_inlet` deliberately
/// lets density float (pinning both rho and u creates a degenerate fixed
/// point -- see its doc comment), and the extrapolation outlet doesn't pin
/// it either, so the domain's absolute density level drifts freely away
/// from the initial 1.0 as the flow develops. `Cp` divides by a very small
/// lattice dynamic pressure (`0.5 * rho0 * u_ref^2` = 1.25e-3 at the
/// standard `U_LATTICE` 0.05), which amplifies that drift enormously:
/// measured on a representative blocked-channel solve, density settled at
/// ~1.056 mean, so referencing the nominal 1.0 put EVERY surface Cp in
/// +11.1..+18.4 -- a huge constant offset that swamped the real pressure
/// variation and saturated the whole surface to one solid color. Against
/// the median instead, the same field gives Cp in -5.7..+1.2 with median
/// ~0.0 and a peak of +1.16 at the stagnation region, which is the
/// physically expected shape (incompressible stagnation Cp = 1).
///
/// The median (not the mean) is the right statistic here: most of the
/// domain is undisturbed freestream, so the median tracks it, while the
/// mean is dragged around by the compressed/rarefied regions that are
/// exactly what Cp is supposed to be measuring against it.
pub fn reference_density(grid: &VoxelGrid, lattice: &Lattice) -> f32 {
    let mut densities: Vec<f32> = (0..lattice.len())
        .filter(|&idx| !grid.solid[idx])
        .map(|idx| lattice.density(idx))
        .collect();
    if densities.is_empty() {
        return 1.0;
    }
    let mid = densities.len() / 2;
    densities.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap());
    densities[mid]
}

/// Pressure coefficient from a lattice density, via the isothermal LBM
/// equation of state `p = cs^2 * rho`. `u_ref` is the freestream/reference
/// lattice speed (typically the inlet speed the solve was driven at);
/// `Cp = 0` is returned rather than dividing by zero if it's ~0.
///
/// `rho0` must be the freestream density of the SOLVED field (see
/// `reference_density`), not the nominal initial density.
pub fn pressure_coefficient(rho: f32, rho0: f32, u_ref: f32) -> f32 {
    let dynamic_pressure = 0.5 * rho0 * u_ref * u_ref;
    if dynamic_pressure < 1e-8 {
        return 0.0;
    }
    (CS2 * rho - CS2 * rho0) / dynamic_pressure
}

fn voxel_coord(grid: &VoxelGrid, pos: Vec3) -> (i64, i64, i64) {
    let cell = grid.cell_size();
    let rel = pos - grid.domain.min;
    (
        (rel.x / cell.x).floor() as i64,
        (rel.y / cell.y).floor() as i64,
        (rel.z / cell.z).floor() as i64,
    )
}

/// Nearest FLUID cell to `pos`, searching outward in expanding cubic shells
/// from the containing (or nearest in-bounds) cell if that cell itself is
/// SOLID -- used to pull a meaningful density/velocity sample near a wing
/// surface vertex, which by construction sits ON or just outside solid
/// voxels where the flow field itself isn't defined.
fn nearest_fluid_cell(grid: &VoxelGrid, pos: Vec3, max_radius: i64) -> Option<usize> {
    let (nx, ny, nz) = grid.dims;
    if nx == 0 || ny == 0 || nz == 0 {
        return None;
    }
    let (cx, cy, cz) = voxel_coord(grid, pos);
    let cx = cx.clamp(0, nx as i64 - 1);
    let cy = cy.clamp(0, ny as i64 - 1);
    let cz = cz.clamp(0, nz as i64 - 1);

    let idx0 = grid.index(cx as usize, cy as usize, cz as usize);
    if !grid.solid[idx0] {
        return Some(idx0);
    }

    for r in 1..=max_radius {
        let mut best: Option<(i64, usize)> = None;
        for dz in -r..=r {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs().max(dy.abs()).max(dz.abs()) != r {
                        continue; // only the outer shell at this radius
                    }
                    let (x, y, z) = (cx + dx, cy + dy, cz + dz);
                    if x < 0 || y < 0 || z < 0 || x >= nx as i64 || y >= ny as i64 || z >= nz as i64 {
                        continue;
                    }
                    let idx = grid.index(x as usize, y as usize, z as usize);
                    if grid.solid[idx] {
                        continue;
                    }
                    let dist2 = dx * dx + dy * dy + dz * dz;
                    if best.is_none_or(|(best_d, _)| dist2 < best_d) {
                        best = Some((dist2, idx));
                    }
                }
            }
        }
        if let Some((_, idx)) = best {
            return Some(idx);
        }
    }
    None
}

/// Surface Cp per mesh vertex, sampled from the nearest FLUID cell along
/// each vertex's outward normal (nudged off the wall by ~1.5 cells so the
/// probe lands in the flow rather than on/inside the solid voxels the wall
/// itself occupies). Returned in the same order as `mesh.vertices`.
pub fn sample_surface_cp(mesh: &Mesh, grid: &VoxelGrid, lattice: &Lattice, rho0: f32, u_ref: f32) -> Vec<f32> {
    let normals = mesh.vertex_normals();
    let offset = grid.cell_size().length() * 1.5;
    let max_radius = 4;

    mesh.vertices
        .iter()
        .zip(normals.iter())
        .map(|(&v, &n)| {
            let probe = if n.length_squared() > 1e-8 { v + n * offset } else { v };
            let cell = nearest_fluid_cell(grid, probe, max_radius).or_else(|| nearest_fluid_cell(grid, v, max_radius));
            match cell {
                Some(idx) => pressure_coefficient(lattice.density(idx), rho0, u_ref),
                None => 0.0,
            }
        })
        .collect()
}

/// A coarse, fixed-size regular-grid velocity sample, downsampled (or
/// upsampled, if the solve grid is smaller) from the native solve
/// resolution via trilinear interpolation -- sized for a Three.js
/// `DataTexture3D` rather than shipping the raw solve grid.
pub struct VelocityFieldSample {
    pub dims: (usize, usize, usize),
    pub domain: Aabb,
    /// `(vx, vy, vz)` interleaved, flattened `x + nx*(y + ny*z)` over `dims`.
    pub data: Vec<f32>,
}

pub fn sample_velocity_field(grid: &VoxelGrid, lattice: &Lattice, target_dims: (usize, usize, usize)) -> VelocityFieldSample {
    let (_, u) = lattice.fields();
    let (tx, ty, tz) = target_dims;
    let mut data = vec![0f32; tx * ty * tz * 3];
    let domain = grid.domain;
    let size = domain.size();

    for zi in 0..tz {
        for yi in 0..ty {
            for xi in 0..tx {
                let fx = (xi as f32 + 0.5) / tx as f32;
                let fy = (yi as f32 + 0.5) / ty as f32;
                let fz = (zi as f32 + 0.5) / tz as f32;
                let pos = domain.min + Vec3::new(fx * size.x, fy * size.y, fz * size.z);
                let vel = trilinear_velocity(grid, &u, pos);
                let out = xi + tx * (yi + ty * zi);
                data[out * 3] = vel.x;
                data[out * 3 + 1] = vel.y;
                data[out * 3 + 2] = vel.z;
            }
        }
    }

    VelocityFieldSample { dims: target_dims, domain, data }
}

fn trilinear_velocity(grid: &VoxelGrid, u: &[Vec3], pos: Vec3) -> Vec3 {
    let cell = grid.cell_size();
    let (nx, ny, nz) = grid.dims;
    // Cell-center-relative continuous coordinates: cell (x,y,z)'s center
    // sits at integer (x,y,z) in this space.
    let rel = (pos - grid.domain.min) / cell - Vec3::splat(0.5);
    let base = rel.floor();
    let t = rel - base;

    let sample = |dx: i32, dy: i32, dz: i32| -> Vec3 {
        let x = (base.x as i64 + dx as i64).clamp(0, nx as i64 - 1) as usize;
        let y = (base.y as i64 + dy as i64).clamp(0, ny as i64 - 1) as usize;
        let z = (base.z as i64 + dz as i64).clamp(0, nz as i64 - 1) as usize;
        let idx = grid.index(x, y, z);
        if grid.solid[idx] {
            Vec3::ZERO // no-slip: zero velocity at/inside solid geometry
        } else {
            u[idx]
        }
    };

    let c00 = sample(0, 0, 0).lerp(sample(1, 0, 0), t.x);
    let c10 = sample(0, 1, 0).lerp(sample(1, 1, 0), t.x);
    let c01 = sample(0, 0, 1).lerp(sample(1, 0, 1), t.x);
    let c11 = sample(0, 1, 1).lerp(sample(1, 1, 1), t.x);
    let c0 = c00.lerp(c10, t.y);
    let c1 = c01.lerp(c11, t.y);
    c0.lerp(c1, t.z)
}

pub struct FlowFieldSample {
    pub surface_cp: Vec<f32>,
    pub velocity_field: VelocityFieldSample,
}

/// The Cp reference density is measured from the solved field here rather
/// than taken as a parameter -- see `reference_density` for why assuming
/// the nominal initial density instead produces a hugely offset (and
/// visually saturated) pressure map.
pub fn sample_flow_field(
    mesh: &Mesh,
    grid: &VoxelGrid,
    lattice: &Lattice,
    u_ref: f32,
    velocity_dims: (usize, usize, usize),
) -> FlowFieldSample {
    let rho_ref = reference_density(grid, lattice);
    FlowFieldSample {
        surface_cp: sample_surface_cp(mesh, grid, lattice, rho_ref, u_ref),
        velocity_field: sample_velocity_field(grid, lattice, velocity_dims),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lattice::feq;

    fn flat_grid(dims: (usize, usize, usize)) -> VoxelGrid {
        VoxelGrid {
            dims,
            domain: Aabb { min: Vec3::ZERO, max: Vec3::new(dims.0 as f32, dims.1 as f32, dims.2 as f32) },
            solid: vec![false; dims.0 * dims.1 * dims.2],
        }
    }

    #[test]
    fn pressure_coefficient_is_zero_at_freestream_density() {
        assert_eq!(pressure_coefficient(1.0, 1.0, 0.05), 0.0);
    }

    #[test]
    fn pressure_coefficient_sign_matches_density_perturbation() {
        let rho0 = 1.0;
        let u_ref = 0.05;
        // Higher local density (compression, e.g. a stagnation point) -> Cp > 0.
        assert!(pressure_coefficient(1.01, rho0, u_ref) > 0.0);
        // Lower local density (rarefaction, e.g. suction peak) -> Cp < 0.
        assert!(pressure_coefficient(0.99, rho0, u_ref) < 0.0);
    }

    #[test]
    fn nearest_fluid_cell_search_finds_a_true_nearest_neighbor() {
        let mut grid = flat_grid((9, 9, 9));
        // A solid ball of Chebyshev radius 2 around the center: every fluid
        // cell in the grid is therefore at Chebyshev distance >= 3 from it,
        // so the search (max_radius 5) must expand past the immediate
        // neighborhood to find anything.
        let center = (4i32, 4i32, 4i32);
        for z in 0..9i32 {
            for y in 0..9i32 {
                for x in 0..9i32 {
                    let cheby = (x - center.0).abs().max((y - center.1).abs()).max((z - center.2).abs());
                    if cheby <= 2 {
                        let idx = grid.index(x as usize, y as usize, z as usize);
                        grid.solid[idx] = true;
                    }
                }
            }
        }

        let pos = Vec3::new(4.5, 4.5, 4.5);
        let found = nearest_fluid_cell(&grid, pos, 5).expect("should find an opening beyond the solid ball");
        assert!(!grid.solid[found], "search must never return a SOLID cell");

        // The solid ball is symmetric, so many fluid cells tie for nearest;
        // rather than asserting one specific index, brute-force-confirm no
        // fluid cell in the grid is strictly closer than the one found.
        let (fx, fy, fz) = crate::lattice::unflatten(found, grid.dims.0, grid.dims.1);
        let dist2 = |x: usize, y: usize, z: usize| -> i64 {
            let dx = x as i64 - center.0 as i64;
            let dy = y as i64 - center.1 as i64;
            let dz = z as i64 - center.2 as i64;
            dx * dx + dy * dy + dz * dz
        };
        let found_dist2 = dist2(fx, fy, fz);
        let true_min = (0..grid.solid.len())
            .filter(|&idx| !grid.solid[idx])
            .map(|idx| {
                let (x, y, z) = crate::lattice::unflatten(idx, grid.dims.0, grid.dims.1);
                dist2(x, y, z)
            })
            .min()
            .expect("grid has fluid cells");
        assert_eq!(found_dist2, true_min, "search did not return a TRUE nearest fluid cell");
    }

    /// Trilinear interpolation reproduces a LINEAR field exactly at any
    /// point, not just at cell centers -- a much stronger check than
    /// sampling only at points that happen to coincide with grid nodes.
    #[test]
    fn velocity_field_sampling_reproduces_linear_field_exactly() {
        let dims = (10, 6, 6);
        let grid = flat_grid(dims);
        let mut lattice = Lattice::new_at_rest(dims, 1.0);
        let rho0 = 1.0;
        let gradient = 0.01; // du_x/dx, lattice units
        for z in 0..dims.2 {
            for y in 0..dims.1 {
                for x in 0..dims.0 {
                    let idx = grid.index(x, y, z);
                    let u = Vec3::new(gradient * (x as f32 + 0.5), 0.0, 0.0);
                    for i in 0..crate::lattice::Q {
                        lattice.f[i][idx] = feq(i, rho0, u);
                    }
                }
            }
        }

        let sample = sample_velocity_field(&grid, &lattice, (20, 12, 12));
        assert_eq!(sample.dims, (20, 12, 12));
        assert_eq!(sample.data.len(), 20 * 12 * 12 * 3);

        // Check a handful of arbitrary output cells against the exact
        // analytical field at that cell's sample position, away from the
        // domain edges (where clamped extrapolation is expected to deviate).
        let (tx, ty, _tz) = (20usize, 12usize, 12usize);
        for &(xi, yi, zi) in &[(10usize, 6usize, 6usize), (5, 3, 8), (15, 9, 2)] {
            let fx = (xi as f32 + 0.5) / tx as f32;
            let expected_x = fx * dims.0 as f32;
            let expected_u = gradient * expected_x;
            let out = xi + tx * (yi + ty * zi);
            let got = sample.data[out * 3];
            assert!(
                (got - expected_u).abs() < 1e-4,
                "at ({xi},{yi},{zi}): got {got}, expected {expected_u}"
            );
            assert!(sample.data[out * 3 + 1].abs() < 1e-6);
            assert!(sample.data[out * 3 + 2].abs() < 1e-6);
        }
    }

    /// Regression test for the "whole surface saturates to one solid color"
    /// bug: referencing Cp against the nominal initial density (1.0) rather
    /// than the solved field's own freestream density puts every cell's Cp
    /// at a large positive offset, because the density level floats freely
    /// (see `reference_density`) and Cp divides by a tiny dynamic pressure.
    ///
    /// Runs a real blocked-channel solve (a slab spanning part of the
    /// cross-section -- qualitatively a wing in the tunnel) and checks the
    /// resulting Cp field is centered and physical rather than offset.
    #[test]
    fn cp_referenced_to_solved_freestream_is_centered_not_offset() {
        use crate::solve_task::Solver;

        let dims = (64usize, 32usize, 32usize);
        let mut grid = VoxelGrid {
            dims,
            domain: Aabb { min: Vec3::ZERO, max: Vec3::new(dims.0 as f32, dims.1 as f32, dims.2 as f32) },
            solid: vec![false; dims.0 * dims.1 * dims.2],
        };
        for z in 6..26 {
            for y in 14..18 {
                for x in 20..32 {
                    let idx = grid.index(x, y, z);
                    grid.solid[idx] = true;
                }
            }
        }

        let u_ref = 0.05f32;
        let mut solver = Solver::new(grid, 0.55, Vec3::new(u_ref, 0.0, 0.0)).expect("valid config");
        solver.run(300, |_| {}, || false);
        let grid = solver.grid();
        let lattice = solver.lattice();

        let rho_ref = reference_density(grid, lattice);
        // The whole point: the field has drifted well away from the nominal
        // 1.0 it was initialized at, which is exactly what made the fixed
        // reference wrong.
        assert!(
            (rho_ref - 1.0).abs() > 1e-3,
            "fixture should exhibit the density drift this fix exists for, got rho_ref={rho_ref}"
        );

        // How far the Cp distribution's center sits from zero, measured in
        // units of its own spread. This is the scale-free signature of the
        // bug: a correctly-referenced Cp field straddles zero (ratio ~0),
        // while an offset one is a tight cluster sitting far from it. Using
        // a ratio rather than an absolute Cp bound keeps the test
        // independent of this fixture's (deliberately high) blockage ratio,
        // which sets the absolute magnitudes.
        let offset_ratio = |rho_reference: f32| -> (f32, f32, f32) {
            let mut cps: Vec<f32> = (0..lattice.len())
                .filter(|&idx| !grid.solid[idx])
                .map(|idx| pressure_coefficient(lattice.density(idx), rho_reference, u_ref))
                .collect();
            cps.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let n = cps.len();
            let median = cps[n / 2];
            let spread = cps[n * 95 / 100] - cps[n * 5 / 100];
            (median.abs() / spread.max(1e-6), cps[0], cps[n - 1])
        };

        let (ratio_fixed, min_fixed, max_fixed) = offset_ratio(rho_ref);
        let (ratio_nominal, min_nominal, _max_nominal) = offset_ratio(1.0);
        eprintln!(
            "rho_ref={rho_ref:.6} | fixed: ratio={ratio_fixed:.3} Cp {min_fixed:.2}..{max_fixed:.2} \
             | nominal 1.0: ratio={ratio_nominal:.3} Cp min {min_nominal:.2}"
        );

        // Fixed: centered on zero relative to its own spread.
        assert!(ratio_fixed < 0.25, "Cp should straddle zero; center/spread ratio was {ratio_fixed}");
        // Both signs genuinely represented (suction AND compression).
        assert!(min_fixed < 0.0 && max_fixed > 0.0, "expected both Cp signs, got {min_fixed}..{max_fixed}");

        // And this fixture really does exhibit the bug being fixed: against
        // the nominal initial density the same field is a far-from-zero
        // cluster (and entirely one-sided), so the assertions above are
        // testing a real difference rather than passing vacuously.
        assert!(
            ratio_nominal > 1.0,
            "fixture should show the offset failure against the nominal reference, got ratio {ratio_nominal}"
        );
        assert!(min_nominal > 0.0, "offset failure should make every Cp one-sided, got min {min_nominal}");
    }

    #[test]
    fn surface_cp_matches_nearby_fluid_density() {
        let dims = (8, 8, 8);
        let mut grid = flat_grid(dims);
        // A thin solid wall at x=3 standing in for a wing skin.
        for z in 0..dims.2 {
            for y in 0..dims.1 {
                let idx = grid.index(3, y, z);
                grid.solid[idx] = true;
            }
        }
        let mut lattice = Lattice::new_at_rest(dims, 1.0);
        let target_rho = 1.02;
        let fluid_idx = grid.index(5, 4, 4); // where the +X-normal probe should land
        for i in 0..crate::lattice::Q {
            lattice.f[i][fluid_idx] = feq(i, target_rho, Vec3::ZERO);
        }

        let mesh = Mesh {
            vertices: vec![Vec3::new(3.5, 4.5, 4.5)], // on the wall, facing +X
            triangles: vec![],
        };
        // vertex_normals() needs triangles to derive a normal; with none,
        // sample_surface_cp falls back to sampling at the vertex itself,
        // which nearest_fluid_cell then resolves outward to fluid_idx's
        // side (x=4, the first open cell walking from the wall).
        let cp = sample_surface_cp(&mesh, &grid, &lattice, 1.0, 0.05);
        assert_eq!(cp.len(), 1);
        // x=4 is fluid at rest density (1.0) in this setup, so Cp should be
        // ~0 there, not at the perturbed cell two steps further out -- this
        // confirms the search finds the NEAREST fluid cell, not a distant
        // one. Tolerance is 1e-3, not tighter, because Cp divides by a small
        // dynamic pressure (0.5*rho0*u_ref^2 = 1.25e-3 here), which amplifies
        // ordinary f32 summation rounding in `density`'s 19-term sum well
        // past 1e-6.
        assert!(cp[0].abs() < 1e-3, "expected ~0 Cp at nearest fluid cell, got {}", cp[0]);
    }
}
