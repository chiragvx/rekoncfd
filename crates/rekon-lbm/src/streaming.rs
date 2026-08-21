use rayon::prelude::*;
use rekon_geometry::VoxelGrid;

use crate::lattice::{opposite, unflatten, Lattice, C, Q};

/// Double-buffered stream-and-swap: for every FLUID cell and direction,
/// pulls (gathers) the population that arrives there this step from
/// wherever it came from, rather than scattering from the source — a gather
/// is what lets every direction's write land in a single, independently
/// rayon-parallel pass over `dst.f[i]` with no cross-buffer aliasing (v1:
/// correctness first, not the AA-pattern in-place optimization).
///
/// For a FLUID target cell `idx` and direction `i`, the source cell is
/// `idx - C[i]`:
/// - if it's FLUID and in-bounds: ordinary streaming, `dst.f[i][idx] = src.f[i][source]`.
/// - if it's SOLID: bounce-back. The population that would have arrived
///   from that solid neighbor is instead the one `idx` itself sent *toward*
///   it last step, reflected: `dst.f[i][idx] = src.f[opposite(i)][idx]`.
///   (Derivation: fluid cell x sends f_j(x) toward a solid neighbor at
///   `x + C[j]`; bounce-back re-appears as `f_opposite(j)(x, t+1) = f_j(x,
///   t)`. Substituting `i = opposite(j)` so `j = opposite(i)`, and noting
///   the solid neighbor is at `x + C[j] = x - C[i]`, gives exactly the rule
///   above with `x = idx`.) This never writes into or reads a meaningful
///   value from a SOLID cell's own storage — the wing/wall geometry only
///   ever needs the FLUID cells adjacent to it.
/// - if it's out-of-bounds (off the domain edge): left as whatever `dst`
///   already held. This only happens for cells on a domain face, and every
///   such face is fully overwritten by `boundary` right after streaming, so
///   the transient stale value here is never actually read by collision.
pub fn stream(src: &Lattice, dst: &mut Lattice, grid: &VoxelGrid) {
    debug_assert_eq!(src.dims, grid.dims);
    debug_assert_eq!(dst.dims, grid.dims);
    let (nx, ny, nz) = src.dims;
    let opp = opposite();

    for i in 0..Q {
        let c = C[i];
        let opp_i = opp[i];
        dst.f[i].par_iter_mut().enumerate().for_each(|(idx, slot)| {
            if grid.solid[idx] {
                return;
            }
            let (x, y, z) = unflatten(idx, nx, ny);
            let sx = x as i64 - c[0] as i64;
            let sy = y as i64 - c[1] as i64;
            let sz = z as i64 - c[2] as i64;
            if sx < 0 || sy < 0 || sz < 0 || sx >= nx as i64 || sy >= ny as i64 || sz >= nz as i64 {
                return;
            }
            let s_idx = grid.index(sx as usize, sy as usize, sz as usize);
            *slot = if grid.solid[s_idx] {
                src.f[opp_i][idx]
            } else {
                src.f[i][s_idx]
            };
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    fn empty_grid(dims: (usize, usize, usize)) -> VoxelGrid {
        use rekon_geometry::Aabb;
        VoxelGrid {
            dims,
            domain: Aabb { min: Vec3::ZERO, max: Vec3::new(dims.0 as f32, dims.1 as f32, dims.2 as f32) },
            solid: vec![false; dims.0 * dims.1 * dims.2],
        }
    }

    /// A single non-equilibrium population placed at one interior cell, in
    /// an all-fluid domain, must appear one lattice step later at exactly
    /// `cell + C[i]` in the same direction slot -- the most direct possible
    /// check that the gather math reproduces plain advection.
    #[test]
    fn interior_population_advects_by_its_own_velocity() {
        let dims = (5, 5, 5);
        let grid = empty_grid(dims);
        let mut src = Lattice::new_at_rest(dims, 1.0);
        let mut dst = src.clone();

        let dir = 11usize; // (1,0,1)
        let origin = grid.index(2, 2, 2);
        src.f[dir][origin] += 0.05;

        stream(&src, &mut dst, &grid);

        let target = grid.index(3, 2, 3);
        let expected = src.f[dir][origin];
        assert!((dst.f[dir][target] - expected).abs() < 1e-6);

        // Every other slot at the target and origin should be untouched
        // (still exactly the rest-equilibrium value), i.e. nothing leaked
        // sideways.
        for i in 0..Q {
            if i == dir {
                continue;
            }
            let rest = crate::lattice::feq(i, 1.0, Vec3::ZERO);
            assert!((dst.f[i][target] - rest).abs() < 1e-6, "direction {i} leaked into target");
        }
    }

    /// A population heading straight at a solid neighbor must come back on
    /// the SAME cell, relabeled with the opposite direction -- the direct
    /// definition of bounce-back, checked against a hand-built one-solid-
    /// neighbor domain.
    #[test]
    fn population_bounces_back_off_adjacent_solid_cell() {
        let dims = (5, 5, 5);
        let mut grid = empty_grid(dims);
        let solid_idx = grid.index(3, 2, 2);
        grid.solid[solid_idx] = true;

        let mut src = Lattice::new_at_rest(dims, 1.0);
        let mut dst = src.clone();

        let toward_solid = 1usize; // (1,0,0): fluid cell (2,2,2) -> solid (3,2,2)
        let fluid_idx = grid.index(2, 2, 2);
        src.f[toward_solid][fluid_idx] += 0.07;

        stream(&src, &mut dst, &grid);

        let opposite_dir = opposite()[toward_solid]; // (-1,0,0)
        assert!((dst.f[opposite_dir][fluid_idx] - src.f[toward_solid][fluid_idx]).abs() < 1e-6);

        // No other fluid cell should have received this population: check
        // the neighbor one step further back along -X, which would only be
        // populated if the reflection incorrectly propagated an extra step.
        let further_back = grid.index(1, 2, 2);
        let rest = crate::lattice::feq(opposite_dir, 1.0, Vec3::ZERO);
        assert!((dst.f[opposite_dir][further_back] - rest).abs() < 1e-6);
    }
}
