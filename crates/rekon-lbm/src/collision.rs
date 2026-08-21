use rayon::prelude::*;

use crate::lattice::{feq, Lattice, Q};

/// BGK single-relaxation-time collision: relax every FLUID cell's
/// distributions toward the local equilibrium by `1/tau`. SOLID cells are
/// skipped entirely — their entries are left untouched (see `Lattice`'s doc
/// comment: they're only ever read via the bounce-back branch in
/// `streaming::stream`, keyed off the neighboring FLUID cell, never as a
/// participant in collision themselves).
///
/// `tau` must be `> 0.5` for BGK stability (`solve_task::Solver::new`
/// enforces this at construction); this function trusts its caller.
pub fn collide(lattice: &mut Lattice, solid: &[bool], tau: f32) {
    let inv_tau = 1.0 / tau;
    let (rho, u) = lattice.fields();

    for i in 0..Q {
        lattice.f[i]
            .par_iter_mut()
            .enumerate()
            .for_each(|(idx, f_i)| {
                if solid[idx] {
                    return;
                }
                let target = feq(i, rho[idx], u[idx]);
                *f_i -= inv_tau * (*f_i - target);
            });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    /// BGK collision conserves mass and momentum EXACTLY (an algebraic
    /// property of the D3Q19 weight/velocity set — see
    /// `lattice::tests::equilibrium_moments_match_input_density_and_velocity`),
    /// so for a spatially uniform field (no streaming needed — every cell is
    /// identical, so streaming would be a no-op on a periodic-equivalent
    /// domain) the local equilibrium target `feq(rho, u)` never moves. That
    /// makes the non-equilibrium part of one perturbed population an EXACT
    /// linear recurrence: `g(t+1) = g(t) * (1 - 1/tau)`. This is a much
    /// stronger check than "looks like it's converging" — it validates the
    /// precise relaxation math, not just its direction.
    #[test]
    fn perturbed_population_decays_geometrically_toward_equilibrium() {
        let dims = (3, 3, 3);
        let n = dims.0 * dims.1 * dims.2;
        let rho0 = 1.0_f32;
        let u0 = Vec3::new(0.08, -0.03, 0.02);
        let tau = 0.8_f32;
        let perturbed_dir = 5usize;
        let delta = 0.02_f32;

        let mut lattice = Lattice::new_uniform(dims, rho0, u0);
        for idx in 0..n {
            lattice.f[perturbed_dir][idx] += delta;
        }
        let solid = vec![false; n];

        // The perturbation itself shifts this cell's density and velocity
        // away from (rho0, u0) -- BGK conserves THESE (perturbed) moments
        // exactly, not the pre-perturbation ones, so the equilibrium target
        // for the geometric-decay check must be built from them.
        let rho_actual = lattice.density(0);
        let u_actual = lattice.velocity(0, rho_actual);
        assert!((rho_actual - (rho0 + delta)).abs() < 1e-6);

        let feq_target = feq(perturbed_dir, rho_actual, u_actual);
        let g0 = lattice.f[perturbed_dir][0] - feq_target;

        let steps = 25;
        for step in 1..=steps {
            collide(&mut lattice, &solid, tau);

            // rho, u must stay exactly (to float rounding) at their
            // post-perturbation values every step -- if they didn't,
            // feq_target below would be stale and this whole test would be
            // checking the wrong thing.
            for idx in 0..n {
                let rho = lattice.density(idx);
                assert!((rho - rho_actual).abs() < 1e-4, "step {step}: density drifted to {rho}");
                let u = lattice.velocity(idx, rho);
                assert!((u - u_actual).length() < 1e-4, "step {step}: velocity drifted to {u}");
            }

            let expected_gap = g0 * (1.0 - 1.0 / tau).powi(step);
            for idx in 0..n {
                let actual_gap = lattice.f[perturbed_dir][idx] - feq_target;
                assert!(
                    (actual_gap - expected_gap).abs() < 1e-5,
                    "step {step}: gap {actual_gap} should equal exact geometric decay {expected_gap}"
                );
            }
        }

        // After 25 steps at tau=0.8 (decay factor 1-1/0.8 = -0.25 per step,
        // magnitude 0.25), the gap should be essentially annihilated --
        // theoretically ~1e-15x the original 0.02, but f32 rounding noise
        // floors it well above that; 1e-6 still confirms real convergence,
        // not just "didn't blow up".
        let final_gap = (lattice.f[perturbed_dir][0] - feq_target).abs();
        assert!(final_gap < 1e-6, "gap should have converged to ~0, got {final_gap}");
    }

    #[test]
    fn solid_cells_are_never_modified_by_collision() {
        let dims = (3, 3, 3);
        let n = dims.0 * dims.1 * dims.2;
        let mut lattice = Lattice::new_uniform(dims, 1.0, Vec3::new(0.1, 0.0, 0.0));
        // Perturb everything so collision would visibly move it if not skipped.
        for i in 0..Q {
            for idx in 0..n {
                lattice.f[i][idx] += 0.01;
            }
        }
        let mut solid = vec![false; n];
        solid[13] = true; // center cell
        let before: Vec<f32> = (0..Q).map(|i| lattice.f[i][13]).collect();

        collide(&mut lattice, &solid, 0.9);

        let after: Vec<f32> = (0..Q).map(|i| lattice.f[i][13]).collect();
        assert_eq!(before, after, "solid cell's distributions must be untouched by collision");
    }
}
