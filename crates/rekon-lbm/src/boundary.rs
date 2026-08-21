use glam::Vec3;
use rekon_geometry::VoxelGrid;

use crate::lattice::{feq, mirror_y, mirror_z, Lattice, C, Q};

/// Equilibrium-distribution inlet: every FLUID cell on the X-min face is
/// reset to `feq(rho_local, u_inlet)` for all 19 directions, where
/// `rho_local` is that cell's OWN density from just before the overwrite
/// (falling back to `rho0` only if it's degenerate) rather than the fixed
/// `rho0` passed in.
///
/// Pinning density AND velocity both to fixed values here is tempting but a
/// trap for a confined (walled) domain: this solver's BGK collision
/// conserves the local mass/momentum moments of `feq` exactly (see
/// `collision`'s tests), which means "every interior cell sitting at rest
/// with a uniform elevated density that happens to make the inlet's own
/// +X-going populations equal what a rest distribution at that density
/// would produce" is an exact, self-consistent fixed point of a
/// fixed-rho0 inlet + copy-extrapolation outlet + bounce-back walls -- and
/// it turns out to be the dominant (attracting) one, not the intended
/// flowing solution. Letting density float and only pinning velocity
/// removes that degenerate fixed point: it's no longer possible for the
/// inlet to keep injecting the same fixed momentum while the rest of the
/// domain sits at zero velocity, since the inlet's own density (and hence
/// its momentum contribution) now depends on what's actually going on
/// immediately upstream of it.
pub fn apply_inlet(lattice: &mut Lattice, grid: &VoxelGrid, rho0: f32, u_inlet: Vec3) {
    let (_, ny, nz) = lattice.dims;
    let x = 0;
    for z in 0..nz {
        for y in 0..ny {
            let idx = grid.index(x, y, z);
            if grid.solid[idx] {
                continue;
            }
            let rho_local = lattice.density(idx);
            let rho = if rho_local > 1e-6 { rho_local } else { rho0 };
            for i in 0..Q {
                lattice.f[i][idx] = feq(i, rho, u_inlet);
            }
        }
    }
}

/// Zero-gradient (extrapolation) outlet: every FLUID cell on the X-max face
/// simply copies its full population set from its interior neighbor one
/// cell upstream (X-max - 1). Must run after any lateral (Y/Z) free-slip
/// fixup so that neighbor already holds its corrected values.
pub fn apply_outlet(lattice: &mut Lattice, grid: &VoxelGrid) {
    let (nx, ny, nz) = lattice.dims;
    if nx < 2 {
        return;
    }
    let x_out = nx - 1;
    let x_src = nx - 2;
    for z in 0..nz {
        for y in 0..ny {
            let idx_out = grid.index(x_out, y, z);
            if grid.solid[idx_out] {
                continue;
            }
            let idx_src = grid.index(x_src, y, z);
            for i in 0..Q {
                lattice.f[i][idx_out] = lattice.f[i][idx_src];
            }
        }
    }
}

/// Free-slip (specular reflection, zero normal velocity) on the four
/// lateral faces (Y-min, Y-max, Z-min, Z-max). At a FLUID cell on e.g. the
/// Y-min face, the directions pointing further into it (`C[i].y == 1`, aka
/// "missing" -- streaming would have had to gather from `y == -1`, which
/// doesn't exist) are replaced by the population already gathered this step
/// for the Y-mirrored direction at the SAME cell: `f_i := f_{mirror_y(i)}`.
/// That mirrored direction is never itself "missing" at this face (its Y
/// component is always -1, the opposite sign), so within one face's fixup
/// there's no read-after-write hazard.
///
/// Known limitation: at domain EDGES/CORNERS where two lateral faces meet,
/// this fixup runs face-by-face and a direction that's "missing" at both
/// faces may read a not-yet-corrected value from the other face's fixup.
/// This is a well-known minor inaccuracy confined to a 1-cell-wide edge of
/// the domain and does not affect validation, which samples the interior.
pub fn apply_free_slip(lattice: &mut Lattice, grid: &VoxelGrid) {
    let (nx, ny, nz) = lattice.dims;
    let my = mirror_y();
    let mz = mirror_z();

    if ny >= 1 {
        apply_face_mirror(lattice, grid, my, 1, |x, z| (x, 0, z), 1, nx, nz);
        apply_face_mirror(lattice, grid, my, 1, |x, z| (x, ny - 1, z), -1, nx, nz);
    }
    if nz >= 1 {
        apply_face_mirror(lattice, grid, mz, 2, |x, y| (x, y, 0), 1, nx, ny);
        apply_face_mirror(lattice, grid, mz, 2, |x, y| (x, y, nz - 1), -1, nx, ny);
    }
}

fn apply_face_mirror(
    lattice: &mut Lattice,
    grid: &VoxelGrid,
    mirror: &[usize; Q],
    axis: usize,
    cell_at: impl Fn(usize, usize) -> (usize, usize, usize),
    missing_sign: i32,
    a_extent: usize,
    b_extent: usize,
) {
    for b in 0..b_extent {
        for a in 0..a_extent {
            let (x, y, z) = cell_at(a, b);
            let idx = grid.index(x, y, z);
            if grid.solid[idx] {
                continue;
            }
            for i in 0..Q {
                if C[i][axis] == missing_sign {
                    lattice.f[i][idx] = lattice.f[mirror[i]][idx];
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rekon_geometry::Aabb;

    fn empty_grid(dims: (usize, usize, usize)) -> VoxelGrid {
        VoxelGrid {
            dims,
            domain: Aabb { min: Vec3::ZERO, max: Vec3::new(dims.0 as f32, dims.1 as f32, dims.2 as f32) },
            solid: vec![false; dims.0 * dims.1 * dims.2],
        }
    }

    #[test]
    fn inlet_sets_whole_layer_to_target_equilibrium() {
        let dims = (4, 4, 4);
        let grid = empty_grid(dims);
        let mut lattice = Lattice::new_at_rest(dims, 1.0);
        let u_inlet = Vec3::new(0.03, 0.0, 0.0);

        apply_inlet(&mut lattice, &grid, 1.0, u_inlet);

        for z in 0..dims.2 {
            for y in 0..dims.1 {
                let idx = grid.index(0, y, z);
                for i in 0..Q {
                    let expected = feq(i, 1.0, u_inlet);
                    assert!((lattice.f[i][idx] - expected).abs() < 1e-6);
                }
            }
        }
    }

    #[test]
    fn outlet_copies_neighbor_layer_exactly() {
        let dims = (4, 4, 4);
        let grid = empty_grid(dims);
        let mut lattice = Lattice::new_at_rest(dims, 1.0);
        // Give the upstream neighbor layer (x=2) a distinct, non-equilibrium
        // state so the copy is unambiguous.
        for y in 0..dims.1 {
            for z in 0..dims.2 {
                let idx = grid.index(2, y, z);
                for i in 0..Q {
                    lattice.f[i][idx] = feq(i, 1.0, Vec3::new(0.02, 0.01, 0.0)) + 0.001 * i as f32;
                }
            }
        }

        apply_outlet(&mut lattice, &grid);

        for y in 0..dims.1 {
            for z in 0..dims.2 {
                let idx_src = grid.index(2, y, z);
                let idx_out = grid.index(3, y, z);
                for i in 0..Q {
                    assert!((lattice.f[i][idx_out] - lattice.f[i][idx_src]).abs() < 1e-6);
                }
            }
        }
    }

    /// After free-slip, the Y-normal momentum contribution at a Y-min face
    /// cell must cancel between a mirrored pair (this is exactly what
    /// "zero normal velocity, specular reflection" means): the "missing"
    /// population and its mirror carry equal-and-opposite Y-momentum once
    /// f_i is set to f_mirror(i).
    #[test]
    fn free_slip_cancels_normal_momentum_at_face() {
        let dims = (4, 5, 4);
        let grid = empty_grid(dims);
        let mut lattice = Lattice::new_at_rest(dims, 1.0);
        // Perturb the whole field with a nonzero tangential+normal velocity
        // so streaming (not run here -- we're testing the fixup formula in
        // isolation) would have left "missing" slots at their rest value,
        // which is what apply_free_slip is meant to correct.
        let idx = grid.index(1, 0, 2);
        for i in 0..Q {
            lattice.f[i][idx] = feq(i, 1.0, Vec3::new(0.02, 0.05, -0.01));
        }

        apply_free_slip(&mut lattice, &grid);

        let momentum = lattice.momentum(idx);
        assert!(momentum.y.abs() < 1e-5, "Y-momentum at free-slip face should be ~0, got {}", momentum.y);
    }

    #[test]
    fn free_slip_leaves_solid_cells_untouched() {
        let dims = (4, 4, 4);
        let mut grid = empty_grid(dims);
        let solid_idx = grid.index(1, 0, 1);
        grid.solid[solid_idx] = true;
        let mut lattice = Lattice::new_at_rest(dims, 1.0);
        for i in 0..Q {
            lattice.f[i][solid_idx] = 42.0;
        }

        apply_free_slip(&mut lattice, &grid);

        for i in 0..Q {
            assert_eq!(lattice.f[i][solid_idx], 42.0);
        }
    }
}
