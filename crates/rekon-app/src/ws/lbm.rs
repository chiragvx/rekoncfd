use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use glam::Vec3;
use rekon_geometry::{voxelize, Aabb, Mesh};
use rekon_lbm::{sample_flow_field, Progress, SolveOutcome, Solver, SolverError};
use rekon_protocol::{encode_f32_frame, encode_solve_result, tags};
use tokio::sync::mpsc::Sender;

use crate::pipeline;
use crate::state::MeshRecord;

/// Base grid resolution for the on-demand LBM solve, before the user's own
/// resolution multiplier (see the Settings menu's "Flow solve quality"
/// section) is applied — deliberately smaller than Phase 2's import-time
/// preview voxel grid (128x64x64), which exists only to report a
/// sanity-checkable occupancy fraction, not to be timestepped hundreds of
/// times. See the project's feasibility research: realistic CPU-only D3Q19
/// throughput is roughly 50-150 MLUPS for a straightforward rayon port, so
/// this cell count keeps a few hundred steps in the few-second range rather
/// than tens of seconds at the default (1.0x) multiplier.
pub(crate) const BASE_SOLVE_VOXEL_DIMS: (usize, usize, usize) = (96, 48, 48);
pub(crate) const BASE_VELOCITY_SAMPLE_DIMS: (usize, usize, usize) = (48, 24, 24);
pub(crate) const BASE_MAX_STEPS: usize = 400;

/// Bounds for the user-adjustable resolution multiplier and step count,
/// enforced server-side regardless of what the client sends -- cell count
/// scales with the CUBE of the multiplier, so the 2.0x ceiling alone is
/// already 8x `BASE_SOLVE_VOXEL_DIMS`'s cell count; combined with the step
/// ceiling that's roughly 16x the default's total lattice-update work,
/// enough to turn a few-second solve into the better part of a minute at
/// the low end of the documented MLUPS range. A client requesting more than
/// this (buggy or otherwise) gets silently clamped, not rejected.
const MIN_RESOLUTION_MULTIPLIER: f32 = 0.5;
const MAX_RESOLUTION_MULTIPLIER: f32 = 2.0;
const MIN_MAX_STEPS: usize = 100;
const MAX_MAX_STEPS: usize = 800;

/// Scales a base `(nx, ny, nz)` by `multiplier`, rounding each axis
/// independently -- keeps the same aspect ratio `BASE_SOLVE_VOXEL_DIMS`/
/// `BASE_VELOCITY_SAMPLE_DIMS` already encode, just at a different overall
/// cell density. Floored at 4 per axis so a very low multiplier can't
/// degenerate into a grid too coarse for the solver's stencil.
fn scaled_dims(base: (usize, usize, usize), multiplier: f32) -> (usize, usize, usize) {
    let scale = |n: usize| ((n as f32 * multiplier).round() as usize).max(4);
    (scale(base.0), scale(base.1), scale(base.2))
}

/// Air kinematic viscosity at sea level, ~15C (m^2/s) — used only to derive a
/// dimensionless Reynolds number from the user's real airspeed/chord; the
/// solver itself never sees physical units (see `rekon_lbm`'s crate docs).
const NU_AIR_M2_PER_S: f64 = 1.5e-5;

/// A conservative, stable lattice inlet speed. BGK-LBM requires tau > 0.5,
/// and matching a real RC-flying-wing Reynolds number (often ~1e5-5e5) at an
/// affordable grid resolution pushes the required tau uncomfortably close to
/// that limit or past it (flagged in this project's original feasibility
/// research). `lattice_params` therefore clamps tau to a stable floor below
/// — meaning the simulation deliberately runs at a lower EFFECTIVE Reynolds
/// number than the real one (elevated numerical viscosity), trading strict
/// physical accuracy for stability, which is standard practice for a
/// real-time-ish qualitative LBM visualization. `U_LATTICE` itself just
/// needs to stay well under the D3Q19 stability ceiling (~0.5*cs = 0.289).
const U_LATTICE: f32 = 0.05;
const MIN_TAU: f32 = 0.55;
const MAX_TAU: f32 = 1.4;

pub struct SolveRequest {
    /// Real geometric pitch rotation (what the UI calls "AoA" -- see
    /// `panel::solve_panel_at_attitude`'s doc comment). Named `alpha_deg`
    /// here for wire-format continuity, but it rotates the mesh, not the
    /// inlet flow direction -- `lattice_params` always uses alpha=0 for the
    /// inlet now, since incidence is baked into the voxelized geometry.
    pub alpha_deg: f64,
    pub v_inf: f64,
    /// Real geometric bank angle (see `panel::solve_panel_at_attitude`'s doc
    /// comment) -- defaults to 0 for older clients that only ever send
    /// `[alpha_deg, v_inf]`, so this stays backward-compatible.
    pub bank_deg: f32,
    /// Real geometric yaw angle -- same backward-compatible default as
    /// `bank_deg`.
    pub yaw_deg: f32,
    /// Scales `BASE_SOLVE_VOXEL_DIMS`/`BASE_VELOCITY_SAMPLE_DIMS` (see
    /// `scaled_dims`) -- already clamped to
    /// `[MIN_RESOLUTION_MULTIPLIER, MAX_RESOLUTION_MULTIPLIER]` by the time
    /// it reaches here. Defaults to 1.0 (the base resolution) for older
    /// clients that don't send it.
    pub resolution_multiplier: f32,
    /// Already clamped to `[MIN_MAX_STEPS, MAX_MAX_STEPS]`. Defaults to
    /// `BASE_MAX_STEPS` for older clients.
    pub max_steps: usize,
}

pub fn decode_solve_request(payload: &[f32]) -> Option<SolveRequest> {
    if payload.len() < 2 {
        return None;
    }
    let resolution_multiplier = payload
        .get(4)
        .copied()
        .unwrap_or(1.0)
        .clamp(MIN_RESOLUTION_MULTIPLIER, MAX_RESOLUTION_MULTIPLIER);
    let max_steps = (payload.get(5).copied().unwrap_or(BASE_MAX_STEPS as f32) as usize).clamp(MIN_MAX_STEPS, MAX_MAX_STEPS);
    Some(SolveRequest {
        alpha_deg: payload[0] as f64,
        v_inf: payload[1] as f64,
        bank_deg: payload.get(2).copied().unwrap_or(0.0),
        yaw_deg: payload.get(3).copied().unwrap_or(0.0),
        resolution_multiplier,
        max_steps,
    })
}

/// Maps the user's real airspeed and the mesh's chord estimate to a stable
/// `(tau, u_inlet)` lattice configuration via Reynolds-number matching,
/// clamped to a safe tau range — see the module-level doc comment. The inlet
/// always points straight along +X (no alpha tilt): incidence is expressed
/// entirely as a real pitch rotation of the voxelized geometry now, not a
/// tilted freestream, so tilting the inlet too would double-count it.
fn lattice_params(v_inf: f64, chord_m: f32, mean_cell_size_m: f32) -> (f32, Vec3) {
    let chord_cells = (chord_m / mean_cell_size_m.max(1e-6)).max(1.0);
    let reynolds = (v_inf.max(1e-3) * chord_m as f64 / NU_AIR_M2_PER_S).max(1.0);
    let nu_lattice = (U_LATTICE as f64) * chord_cells as f64 / reynolds;
    let tau = (0.5 + nu_lattice / rekon_lbm::CS2 as f64) as f32;
    let tau = tau.clamp(MIN_TAU, MAX_TAU);

    let u_inlet = Vec3::new(U_LATTICE, 0.0, 0.0);
    (tau, u_inlet)
}

/// Result of running one full LBM solve to completion.
pub(crate) struct LbmFrameResult {
    pub surface_cp: Vec<f32>,
    pub vel_dims: (u32, u32, u32),
    pub domain_min: [f32; 3],
    pub domain_max: [f32; 3],
    pub velocity: Vec<f32>,
}

pub(crate) enum LbmRunError {
    Solver(SolverError),
    Diverged,
    StoppedByCaller,
}

/// Voxelizes `mesh` into `domain`, configures a solver for `v_inf` (the
/// mesh's own attitude already encodes any bank/pitch/yaw), and runs it to
/// completion (or until `should_stop`) — the shared core of both the
/// on-demand single solve (`run_solve`, below) and the bank-sweep
/// animation's per-frame batch job (`ws::bank_sweep`): both just need "given
/// this mesh + domain + condition, run LBM to completion and hand back the
/// field", differing only in what they do with the result afterward
/// (encode+send one `SolveResult`, vs. bundle it alongside a panel-method
/// solve into one `MultiBankSweepFrame`) and in WHERE `domain` comes from --
/// `run_solve` computes it fresh from its one mesh, same as always, while
/// the bank-sweep computes it ONCE (from the original, unrotated mesh) and
/// passes that SAME domain for every rotated frame, so the wind-tunnel box
/// never changes size/shape across a batch (see
/// `pipeline::attitude_invariant_domain`'s doc comment for why that
/// matters). `mesh` is passed in (rather than always coming from a
/// `MeshRecord`) specifically so the bank-sweep job can pass a ROTATED mesh
/// — a real re-solve on rotated geometry, not the original.
pub(crate) fn run_lbm_to_completion(
    mesh: &Mesh,
    domain: Aabb,
    chord_m: f32,
    v_inf: f64,
    solve_voxel_dims: (usize, usize, usize),
    velocity_sample_dims: (usize, usize, usize),
    max_steps: usize,
    mut on_progress: impl FnMut(Progress),
    mut should_stop: impl FnMut() -> bool,
) -> Result<LbmFrameResult, LbmRunError> {
    let grid = voxelize(mesh, domain, solve_voxel_dims);
    let cell_size = grid.cell_size();
    let mean_cell_size = (cell_size.x + cell_size.y + cell_size.z) / 3.0;

    let (tau, u_inlet) = lattice_params(v_inf, chord_m, mean_cell_size);

    let mut solver = Solver::new(grid, tau, u_inlet).map_err(LbmRunError::Solver)?;

    let outcome = solver.run(max_steps, &mut on_progress, &mut should_stop);
    match outcome {
        SolveOutcome::StoppedByCaller { .. } => return Err(LbmRunError::StoppedByCaller),
        SolveOutcome::Diverged { .. } => return Err(LbmRunError::Diverged),
        SolveOutcome::Completed { .. } => {}
    }

    let sample = sample_flow_field(mesh, solver.grid(), solver.lattice(), U_LATTICE, velocity_sample_dims);
    let domain = sample.velocity_field.domain;
    Ok(LbmFrameResult {
        surface_cp: sample.surface_cp,
        vel_dims: (velocity_sample_dims.0 as u32, velocity_sample_dims.1 as u32, velocity_sample_dims.2 as u32),
        domain_min: domain.min.into(),
        domain_max: domain.max.into(),
        velocity: sample.velocity_field.data,
    })
}

/// Runs one on-demand solve to completion (or until `generation` no longer
/// matches `current_generation`, meaning a newer request superseded this
/// one), streaming `SolveProgress` frames and a final `SolveResult` back
/// through `tx`. Must be called from inside `tokio::task::spawn_blocking` —
/// this function itself is fully synchronous CPU work.
pub fn run_solve(
    record: Arc<MeshRecord>,
    request: SolveRequest,
    generation: u64,
    current_generation: Arc<AtomicU64>,
    tx: Sender<Vec<u8>>,
) {
    let chord_m = record.chord_estimate_m;
    // Bank/pitch/yaw are all real rotations of the mesh (see
    // `panel::solve_panel_at_attitude`'s doc comment) -- when any is nonzero
    // this must use the ROTATION-INVARIANT domain sizing
    // (`attitude_invariant_domain`), or the wind-tunnel box would silently
    // be undersized for whatever attitude was actually solved. Level flight
    // (all three zero) keeps the original sizing exactly as before, so this
    // is a pure extension, not a behavior change at the default attitude.
    let any_rotation = request.bank_deg.abs() > 1e-6 || request.alpha_deg.abs() > 1e-6 || request.yaw_deg.abs() > 1e-6;
    let rotated_mesh;
    let mesh: &Mesh = if any_rotation {
        rotated_mesh = record.mesh.rotated_by_attitude(request.bank_deg, request.alpha_deg as f32, request.yaw_deg);
        &rotated_mesh
    } else {
        &record.mesh
    };
    let domain = if any_rotation {
        pipeline::attitude_invariant_domain(&record.mesh, chord_m.max(0.05) * 4.0)
    } else {
        pipeline::default_wind_tunnel_domain(mesh, chord_m.max(0.05) * 4.0)
    };

    let solve_voxel_dims = scaled_dims(BASE_SOLVE_VOXEL_DIMS, request.resolution_multiplier);
    let velocity_sample_dims = scaled_dims(BASE_VELOCITY_SAMPLE_DIMS, request.resolution_multiplier);

    let tx_progress = tx.clone();
    let current_gen_check = current_generation.clone();
    // `mesh` already bakes `request.alpha_deg` in as a pitch rotation above,
    // so the inlet flow direction stays straight (`lattice_params` no longer
    // takes an alpha at all) -- tilting it too would double-count the
    // incidence angle.
    let result = run_lbm_to_completion(
        mesh,
        domain,
        chord_m,
        request.v_inf,
        solve_voxel_dims,
        velocity_sample_dims,
        request.max_steps,
        move |p: Progress| {
            let payload = [p.step as f32, p.max_steps as f32, p.max_velocity, p.mean_density];
            let _ = tx_progress.try_send(encode_f32_frame(tags::SOLVE_PROGRESS, &payload));
        },
        move || current_gen_check.load(Ordering::Relaxed) != generation,
    );

    match result {
        Ok(r) => {
            let frame = encode_solve_result(tags::SOLVE_RESULT, &r.surface_cp, r.vel_dims, r.domain_min, r.domain_max, &r.velocity);
            let _ = tx.blocking_send(frame);
        }
        Err(LbmRunError::StoppedByCaller) => {
            // A newer request has already taken over this connection's
            // output; no need to send anything for this superseded run.
        }
        Err(LbmRunError::Diverged) => {
            tracing::warn!("LBM solve diverged (tau likely still too aggressive for this case)");
            let _ = tx.blocking_send(encode_f32_frame(tags::SOLVE_CANCELLED_OR_ERROR, &[]));
        }
        Err(LbmRunError::Solver(err)) => {
            tracing::warn!(%err, "failed to configure LBM solver");
            let _ = tx.blocking_send(encode_f32_frame(tags::SOLVE_CANCELLED_OR_ERROR, &[]));
        }
    }
}
