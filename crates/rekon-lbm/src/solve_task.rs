use glam::Vec3;
use rekon_geometry::VoxelGrid;
use thiserror::Error;

use crate::boundary;
use crate::collision;
use crate::lattice::Lattice;
use crate::streaming;

#[derive(Debug, Error)]
pub enum SolverError {
    #[error("tau must be > 0.5 for BGK stability, got {0}")]
    InvalidTau(f32),
    #[error("voxel grid dimensions must be at least 3 along every axis, got {0:?}")]
    GridTooSmall((usize, usize, usize)),
    #[error("inlet lattice velocity magnitude {0} is too high for stable/subsonic BGK (keep it well under cs = {1:.3})")]
    InletVelocityTooHigh(f32, f32),
    #[error("initial lattice dims {lattice:?} do not match voxel grid dims {grid:?}")]
    DimsMismatch { grid: (usize, usize, usize), lattice: (usize, usize, usize) },
}

/// Reported to the caller's `on_progress` hook after every step. Cheap to
/// compute (one extra rayon pass over the field, same order as a single
/// collision direction-pass) and gives a caller (e.g. a future WS handler)
/// enough to render a live residual/velocity readout without touching solver
/// internals.
#[derive(Debug, Clone, Copy)]
pub struct Progress {
    pub step: u64,
    pub max_steps: u64,
    pub max_velocity: f32,
    pub mean_density: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SolveOutcome {
    Completed { steps: u64 },
    StoppedByCaller { steps: u64 },
    Diverged { steps: u64 },
}

/// Owns the double-buffered D3Q19 lattice state over a `VoxelGrid` and
/// drives it forward one BGK-collide + stream + boundary-condition cycle at
/// a time. Deliberately synchronous and free of any async runtime — see the
/// crate-level docs for why, and `run`'s `should_stop` hook for how a caller
/// wraps this in `tokio::spawn_blocking` with cancellation later.
pub struct Solver {
    grid: VoxelGrid,
    front: Lattice,
    back: Lattice,
    tau: f32,
    rho0: f32,
    u_inlet: Vec3,
    step: u64,
}

/// Divergence guard: once the flow speed exceeds this multiple of cs, BGK is
/// well outside its intended low-Mach regime and results are not physically
/// meaningful, whatever `run` was told to keep going for.
const DIVERGENCE_SPEED_FACTOR: f32 = 3.0;

impl Solver {
    pub fn new(grid: VoxelGrid, tau: f32, u_inlet: Vec3) -> Result<Self, SolverError> {
        Self::validate(&grid, tau, u_inlet)?;
        let rho0 = 1.0;
        let front = Lattice::new_at_rest(grid.dims, rho0);
        let back = front.clone();
        Ok(Self { grid, front, back, tau, rho0, u_inlet, step: 0 })
    }

    /// As `new`, but seeded from a caller-supplied initial field instead of
    /// rest — useful both for warm-starting a re-run from a previous solve's
    /// converged state, and for validation cases (e.g. mass conservation)
    /// that need a specific non-uniform initial condition rather than the
    /// uniform rest state `new` always starts from.
    pub fn from_lattice(grid: VoxelGrid, lattice: Lattice, tau: f32, u_inlet: Vec3) -> Result<Self, SolverError> {
        Self::validate(&grid, tau, u_inlet)?;
        if lattice.dims != grid.dims {
            return Err(SolverError::DimsMismatch { grid: grid.dims, lattice: lattice.dims });
        }
        let rho0 = 1.0;
        let back = lattice.clone();
        Ok(Self { grid, front: lattice, back, tau, rho0, u_inlet, step: 0 })
    }

    fn validate(grid: &VoxelGrid, tau: f32, u_inlet: Vec3) -> Result<(), SolverError> {
        if !(tau > 0.5) {
            return Err(SolverError::InvalidTau(tau));
        }
        let (nx, ny, nz) = grid.dims;
        if nx < 3 || ny < 3 || nz < 3 {
            return Err(SolverError::GridTooSmall(grid.dims));
        }
        let cs = crate::lattice::CS2.sqrt();
        if u_inlet.length() >= 0.5 * cs {
            return Err(SolverError::InletVelocityTooHigh(u_inlet.length(), cs));
        }
        Ok(())
    }

    pub fn grid(&self) -> &VoxelGrid {
        &self.grid
    }

    pub fn lattice(&self) -> &Lattice {
        &self.front
    }

    pub fn tau(&self) -> f32 {
        self.tau
    }

    pub fn rho0(&self) -> f32 {
        self.rho0
    }

    pub fn u_inlet(&self) -> Vec3 {
        self.u_inlet
    }

    pub fn step_count(&self) -> u64 {
        self.step
    }

    /// One collide -> stream -> boundary-condition cycle. `front` holds a
    /// fully boundary-consistent field both before and after this call, so
    /// steps compose freely.
    pub fn step(&mut self) {
        collision::collide(&mut self.front, &self.grid.solid, self.tau);
        streaming::stream(&self.front, &mut self.back, &self.grid);
        std::mem::swap(&mut self.front, &mut self.back);
        boundary::apply_free_slip(&mut self.front, &self.grid);
        boundary::apply_inlet(&mut self.front, &self.grid, self.rho0, self.u_inlet);
        boundary::apply_outlet(&mut self.front, &self.grid);
        self.step += 1;
    }

    /// Runs up to `max_steps` further steps, calling `on_progress` after
    /// each one and checking `should_stop` before each one. Both are plain
    /// closures — no async, no channel — so a caller on an async runtime can
    /// drive this from inside `spawn_blocking`, feeding `should_stop` from
    /// e.g. an `AtomicBool` or cancellation token and forwarding `Progress`
    /// out over whatever channel it likes, without this crate knowing any
    /// of that exists.
    pub fn run(
        &mut self,
        max_steps: usize,
        mut on_progress: impl FnMut(Progress),
        mut should_stop: impl FnMut() -> bool,
    ) -> SolveOutcome {
        let start = self.step;
        for _ in 0..max_steps {
            if should_stop() {
                return SolveOutcome::StoppedByCaller { steps: self.step - start };
            }
            self.step();

            let (rho, u) = self.front.fields();
            let max_velocity = u.iter().map(|v| v.length()).fold(0.0f32, f32::max);
            let mean_density = rho.iter().sum::<f32>() / rho.len().max(1) as f32;

            if !max_velocity.is_finite() || !mean_density.is_finite() || max_velocity > DIVERGENCE_SPEED_FACTOR * crate::lattice::CS2.sqrt() {
                return SolveOutcome::Diverged { steps: self.step - start };
            }

            on_progress(Progress { step: self.step, max_steps: max_steps as u64, max_velocity, mean_density });
        }
        SolveOutcome::Completed { steps: self.step - start }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rekon_geometry::Aabb;

    fn open_grid(dims: (usize, usize, usize)) -> VoxelGrid {
        VoxelGrid {
            dims,
            domain: Aabb { min: Vec3::ZERO, max: Vec3::new(dims.0 as f32, dims.1 as f32, dims.2 as f32) },
            solid: vec![false; dims.0 * dims.1 * dims.2],
        }
    }

    #[test]
    fn rejects_tau_at_or_below_stability_limit() {
        let grid = open_grid((4, 4, 4));
        assert!(matches!(Solver::new(grid.clone(), 0.5, Vec3::ZERO), Err(SolverError::InvalidTau(_))));
        assert!(matches!(Solver::new(grid, 0.4, Vec3::ZERO), Err(SolverError::InvalidTau(_))));
    }

    #[test]
    fn accepts_valid_tau_and_runs() {
        let grid = open_grid((6, 6, 6));
        let mut solver = Solver::new(grid, 0.8, Vec3::new(0.02, 0.0, 0.0)).expect("valid config");
        let mut progress_calls = 0;
        let outcome = solver.run(10, |_p| progress_calls += 1, || false);
        assert_eq!(outcome, SolveOutcome::Completed { steps: 10 });
        assert_eq!(progress_calls, 10);
        assert_eq!(solver.step_count(), 10);
    }

    #[test]
    fn should_stop_halts_run_early_without_running_further_steps() {
        let grid = open_grid((6, 6, 6));
        let mut solver = Solver::new(grid, 0.8, Vec3::ZERO).expect("valid config");
        let mut calls = 0;
        let outcome = solver.run(
            100,
            |_p| {},
            || {
                calls += 1;
                calls > 5
            },
        );
        assert_eq!(outcome, SolveOutcome::StoppedByCaller { steps: 5 });
        assert_eq!(solver.step_count(), 5);
    }
}
