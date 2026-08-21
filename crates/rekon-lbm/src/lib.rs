//! 3D Lattice Boltzmann (D3Q19, BGK) flow solver over a
//! `rekon_geometry::voxelizer::VoxelGrid`.
//!
//! Everything here runs in dimensionless lattice units (cell size = 1,
//! timestep = 1, rest density ~1) — mapping a real `VoxelGrid`'s physical
//! `cell_size()`/domain and a target Reynolds number into `tau` and an inlet
//! lattice velocity is the caller's job (a later, app-integration phase);
//! this crate never touches meters, seconds, or Pascals.
//!
//! This is a synchronous, pure-compute library with no async runtime
//! dependency — see `solve_task::Solver::run` for how a caller drives it
//! from an async context without this crate needing to know that runtime
//! exists.

pub mod boundary;
pub mod collision;
pub mod lattice;
pub mod sampling;
pub mod solve_task;
pub mod streaming;

pub use lattice::{Lattice, C, CS2, Q, W};
pub use sampling::{
    reference_density, sample_flow_field, sample_surface_cp, sample_velocity_field, FlowFieldSample,
    VelocityFieldSample,
};
pub use solve_task::{Progress, SolveOutcome, Solver, SolverError};

#[cfg(test)]
mod validation_tests {
    use super::*;
    use glam::Vec3;
    use rekon_geometry::{Aabb, VoxelGrid};

    fn open_grid(dims: (usize, usize, usize)) -> VoxelGrid {
        VoxelGrid {
            dims,
            domain: Aabb { min: Vec3::ZERO, max: Vec3::new(dims.0 as f32, dims.1 as f32, dims.2 as f32) },
            solid: vec![false; dims.0 * dims.1 * dims.2],
        }
    }

    fn total_fluid_mass(lattice: &Lattice, grid: &VoxelGrid) -> f32 {
        (0..lattice.len())
            .filter(|&idx| !grid.solid[idx])
            .map(|idx| lattice.density(idx))
            .sum()
    }

    /// Closed box: bounce-back walls on every face, no inlet/outlet. Starts
    /// from a non-trivial (non-uniform density and velocity) field and runs
    /// many steps. Streaming only re-labels/relocates existing populations
    /// (see `streaming::stream`'s doc comment) and BGK collision conserves
    /// mass exactly per cell, so total fluid mass in a sealed box is a hard
    /// invariant -- a bug in either the streaming index math or the
    /// bounce-back branch would leak or duplicate mass and this test would
    /// catch it even though a "looks about right" velocity check would not.
    #[test]
    fn mass_is_conserved_in_a_fully_closed_domain() {
        let dims = (10, 10, 10);
        let mut grid = open_grid(dims);
        for z in 0..dims.2 {
            for y in 0..dims.1 {
                for x in 0..dims.0 {
                    let on_boundary =
                        x == 0 || x == dims.0 - 1 || y == 0 || y == dims.1 - 1 || z == 0 || z == dims.2 - 1;
                    if on_boundary {
                        let idx = grid.index(x, y, z);
                        grid.solid[idx] = true;
                    }
                }
            }
        }

        // Non-trivial, non-uniform initial condition: a density bump with a
        // swirling velocity field. `from_lattice` seeds this directly rather
        // than going through `Solver::new`'s uniform rest state, since a
        // trivially-uniform field would never exercise the streaming index
        // math or bounce-back branch strongly enough to catch a real bug.
        let mut lattice = Lattice::new_at_rest(dims, 1.0);
        for z in 1..dims.2 - 1 {
            for y in 1..dims.1 - 1 {
                for x in 1..dims.0 - 1 {
                    let idx = grid.index(x, y, z);
                    let dx = x as f32 - 5.0;
                    let dy = y as f32 - 5.0;
                    let bump = 1.0 + 0.15 * (-(dx * dx + dy * dy) / 6.0).exp();
                    let u = Vec3::new(0.02 * (y as f32 - 5.0), -0.02 * (x as f32 - 5.0), 0.01);
                    for i in 0..Q {
                        lattice.f[i][idx] = lattice::feq(i, bump, u);
                    }
                }
            }
        }
        // Every face is solid, so the inlet/outlet/free-slip passes `step`
        // applies each step all skip every cell on their respective face
        // (see boundary::apply_inlet/outlet/free_slip's solid checks) --
        // this really is a fully closed box regardless of the u_inlet
        // parameter below, which is therefore inert here.
        let mut solver = Solver::from_lattice(grid.clone(), lattice, 0.8, Vec3::ZERO).expect("valid config");

        let initial_mass = total_fluid_mass(solver.lattice(), &grid);
        assert!(initial_mass > 0.0);

        for _ in 0..400 {
            solver.step();
        }

        let final_mass = total_fluid_mass(solver.lattice(), &grid);
        let relative_error = (final_mass - initial_mass).abs() / initial_mass;
        assert!(
            relative_error < 1e-4,
            "mass drifted by {relative_error:e} over 400 steps in a closed domain (initial {initial_mass}, final {final_mass})"
        );
    }

    /// Hundreds of steps at a stable-but-not-overly-diffusive tau, driven by
    /// an inlet, must not blow up: no NaN/Inf anywhere, and velocities stay
    /// within a sane multiple of the driving speed. This is the basic
    /// "doesn't diverge" guard rail the physical validations above assume
    /// holds.
    #[test]
    fn stays_bounded_and_finite_over_many_steps() {
        let dims = (24, 12, 8);
        let mut grid = open_grid(dims);
        for z in 0..dims.2 {
            for x in 0..dims.0 {
                let lo = grid.index(x, 0, z);
                let hi = grid.index(x, dims.1 - 1, z);
                grid.solid[lo] = true;
                grid.solid[hi] = true;
            }
        }
        let u_inlet = Vec3::new(0.04, 0.0, 0.0);
        let mut solver = Solver::new(grid, 0.7, u_inlet).expect("valid config");

        let outcome = solver.run(600, |p| {
            assert!(p.max_velocity.is_finite());
            assert!(p.mean_density.is_finite());
            assert!(
                p.max_velocity < 5.0 * u_inlet.length(),
                "velocity blew up to {} at step {}",
                p.max_velocity,
                p.step
            );
        }, || false);

        assert_eq!(outcome, SolveOutcome::Completed { steps: 600 });

        for idx in 0..solver.lattice().len() {
            for i in 0..Q {
                let v = solver.lattice().f[i][idx];
                assert!(v.is_finite(), "non-finite population at cell {idx}, direction {i}: {v}");
            }
        }
    }

    /// The standard LBM benchmark: pressure-driven channel (Poiseuille)
    /// flow between two bounce-back walls, compared against the analytical
    /// parabolic profile `u(y) = 6*u_mean*eta*(1-eta)`.
    ///
    /// Two tolerance/methodology notes, both load-bearing for why this test
    /// is trustworthy rather than a tuned-to-pass magic-number check:
    ///
    /// 1. `eta` is measured from `y = 0.5` / `y = (ny-1) - 0.5`, not from the
    ///    solid cells' own centers. For a straight, lattice-aligned wall,
    ///    simple bounce-back is a well-documented *exact* result placing the
    ///    no-slip wall exactly half a lattice unit beyond the last fluid
    ///    node -- this isn't a fitted offset.
    /// 2. The profile is compared against `6*u_mean*eta*(1-eta)` using the
    ///    MEASURED cross-sectional mean velocity, not the raw `u0` handed to
    ///    the inlet. `apply_inlet` intentionally lets density float (see its
    ///    doc comment) rather than pinning it to `rho0`, which avoids a real
    ///    degenerate fixed point of this BC combination on a confined
    ///    channel -- but it also means the developed mean flow rate settles
    ///    to whatever this inlet/outlet pairing actually sustains rather
    ///    than exactly `u0` (measured here at ~75% of `u0` for this
    ///    geometry). The physically meaningful, benchmark-standard
    ///    invariant being validated is the SHAPE of Poiseuille flow --
    ///    parabolic, symmetric, peak = 1.5x the cross-sectional mean --
    ///    which is exactly what's checked below, independent of that
    ///    absolute-throughput offset.
    #[test]
    fn poiseuille_profile_matches_analytical_parabola() {
        // Best-effort: makes the summary below visible under `cargo test --
        // --nocapture`; irrelevant to the assertions if it's already
        // installed by another test in this binary.
        let _ = tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).try_init();

        let dims = (48, 14, 5);
        let mut grid = open_grid(dims);
        // No-slip walls: solid slabs at Y-min and Y-max. Fluid occupies
        // y in [1, dims.1-2].
        for z in 0..dims.2 {
            for x in 0..dims.0 {
                let lo = grid.index(x, 0, z);
                let hi = grid.index(x, dims.1 - 1, z);
                grid.solid[lo] = true;
                grid.solid[hi] = true;
            }
        }

        let tau = 0.9_f32;
        let u0 = 0.02_f32; // target inlet lattice-velocity
        let mut solver = Solver::new(grid.clone(), tau, Vec3::new(u0, 0.0, 0.0)).expect("valid config");

        let steps = 800;
        let outcome = solver.run(steps, |_p| {}, || false);
        assert_eq!(outcome, SolveOutcome::Completed { steps: steps as u64 });

        // Sample well downstream of the inlet (entrance-length effects) and
        // upstream of the outlet (extrapolation-BC effects).
        let sample_x = dims.0 * 3 / 4;
        let z = dims.2 / 2;
        let (_, u) = solver.lattice().fields();

        let wall_lo = 0.5_f32;
        let wall_hi = (dims.1 - 1) as f32 - 0.5;
        let gap = wall_hi - wall_lo;

        let profile: Vec<f32> = (1..dims.1 - 1).map(|y| u[grid.index(sample_x, y, z)].x).collect();
        let mean_u = profile.iter().sum::<f32>() / profile.len() as f32;
        let max_u = profile.iter().cloned().fold(0.0f32, f32::max);

        let mut sum_sq_err = 0.0f64;
        let mut sum_sq_ref = 0.0f64;
        for (i, &ux) in profile.iter().enumerate() {
            let y = i + 1;
            let eta = (y as f32 - wall_lo) / gap;
            let analytical = 6.0 * mean_u * eta * (1.0 - eta);
            let err = (ux - analytical) as f64;
            sum_sq_err += err * err;
            sum_sq_ref += (analytical as f64) * (analytical as f64);
        }
        let l2_relative_error = (sum_sq_err / sum_sq_ref.max(1e-12)).sqrt();
        let peak_to_mean_ratio = max_u / mean_u;

        tracing::info!(
            grid_dims = ?dims,
            tau,
            steps,
            u0,
            mean_u,
            max_u,
            peak_to_mean_ratio,
            expected_peak_to_mean_ratio = 1.5,
            l2_relative_error,
            "Poiseuille validation: measured vs analytical parabolic profile"
        );

        // Real, developed flow (not the degenerate zero-velocity fixed
        // point a confined channel's equilibrium-inlet BC can otherwise
        // collapse to -- see apply_inlet's doc comment): the channel must
        // actually be carrying a substantial fraction of the requested
        // inlet speed.
        assert!(mean_u > 0.3 * u0, "mean channel velocity {mean_u} suspiciously low vs target inlet speed {u0}");

        // The defining shape signature of Poiseuille flow: peak = 1.5x mean.
        assert!(
            (peak_to_mean_ratio - 1.5).abs() < 0.05,
            "peak/mean velocity ratio {peak_to_mean_ratio} should be close to the parabolic-profile value 1.5"
        );

        // Point-by-point shape match against the parabola implied by the
        // measured mean.
        assert!(
            l2_relative_error < 0.03,
            "Poiseuille profile L2 relative error {l2_relative_error} exceeds tolerance (grid {dims:?}, tau {tau}, steps {steps})"
        );
    }
}
