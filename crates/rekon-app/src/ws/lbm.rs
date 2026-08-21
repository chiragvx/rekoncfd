use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use glam::Vec3;
use rekon_geometry::voxelize;
use rekon_lbm::{sample_flow_field, Progress, SolveOutcome, Solver};
use rekon_protocol::{encode_f32_frame, encode_solve_result, tags};
use tokio::sync::mpsc::Sender;

use crate::pipeline;
use crate::state::MeshRecord;

/// Grid resolution dedicated to the on-demand LBM solve — deliberately
/// smaller than Phase 2's import-time preview voxel grid (128x64x64), which
/// exists only to report a sanity-checkable occupancy fraction, not to be
/// timestepped hundreds of times. See the project's feasibility research:
/// realistic CPU-only D3Q19 throughput is roughly 50-150 MLUPS for a
/// straightforward rayon port, so this cell count keeps a few hundred steps
/// in the few-second range rather than tens of seconds.
const SOLVE_VOXEL_DIMS: (usize, usize, usize) = (96, 48, 48);
const VELOCITY_SAMPLE_DIMS: (usize, usize, usize) = (48, 24, 24);
const MAX_STEPS: usize = 400;

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
    pub alpha_deg: f64,
    pub v_inf: f64,
}

pub fn decode_solve_request(payload: &[f32]) -> Option<SolveRequest> {
    if payload.len() < 2 {
        return None;
    }
    Some(SolveRequest { alpha_deg: payload[0] as f64, v_inf: payload[1] as f64 })
}

/// Maps the user's real AoA/airspeed and the mesh's chord estimate to a
/// stable `(tau, u_inlet)` lattice configuration via Reynolds-number
/// matching, clamped to a safe tau range — see the module-level doc comment.
fn lattice_params(alpha_deg: f64, v_inf: f64, chord_m: f32, mean_cell_size_m: f32) -> (f32, Vec3) {
    let chord_cells = (chord_m / mean_cell_size_m.max(1e-6)).max(1.0);
    let reynolds = (v_inf.max(1e-3) * chord_m as f64 / NU_AIR_M2_PER_S).max(1.0);
    let nu_lattice = (U_LATTICE as f64) * chord_cells as f64 / reynolds;
    let tau = (0.5 + nu_lattice / rekon_lbm::CS2 as f64) as f32;
    let tau = tau.clamp(MIN_TAU, MAX_TAU);

    let alpha_rad = alpha_deg.to_radians() as f32;
    let u_inlet = Vec3::new(U_LATTICE * alpha_rad.cos(), U_LATTICE * alpha_rad.sin(), 0.0);
    (tau, u_inlet)
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
    let mesh = &record.mesh;
    let chord_m = record.chord_estimate_m;
    let domain = pipeline::default_wind_tunnel_domain(mesh, chord_m.max(0.05) * 4.0);
    let grid = voxelize(mesh, domain, SOLVE_VOXEL_DIMS);
    let cell_size = grid.cell_size();
    let mean_cell_size = (cell_size.x + cell_size.y + cell_size.z) / 3.0;

    let (tau, u_inlet) = lattice_params(request.alpha_deg, request.v_inf, chord_m, mean_cell_size);

    let mut solver = match Solver::new(grid, tau, u_inlet) {
        Ok(s) => s,
        Err(err) => {
            tracing::warn!(%err, "failed to configure LBM solver");
            let _ = tx.blocking_send(encode_f32_frame(tags::SOLVE_CANCELLED_OR_ERROR, &[]));
            return;
        }
    };

    let tx_progress = tx.clone();
    let current_gen_check = current_generation.clone();
    let outcome = solver.run(
        MAX_STEPS,
        |p: Progress| {
            let payload = [p.step as f32, p.max_steps as f32, p.max_velocity, p.mean_density];
            let _ = tx_progress.try_send(encode_f32_frame(tags::SOLVE_PROGRESS, &payload));
        },
        || current_gen_check.load(Ordering::Relaxed) != generation,
    );

    match outcome {
        SolveOutcome::StoppedByCaller { .. } => {
            // A newer request has already taken over this connection's
            // output; no need to send anything for this superseded run.
            return;
        }
        SolveOutcome::Diverged { steps } => {
            tracing::warn!(steps, "LBM solve diverged (tau {tau} likely still too aggressive for this case)");
            let _ = tx.blocking_send(encode_f32_frame(tags::SOLVE_CANCELLED_OR_ERROR, &[]));
            return;
        }
        SolveOutcome::Completed { .. } => {}
    }

    let sample = sample_flow_field(mesh, solver.grid(), solver.lattice(), U_LATTICE, VELOCITY_SAMPLE_DIMS);
    let domain = sample.velocity_field.domain;
    let frame = encode_solve_result(
        tags::SOLVE_RESULT,
        &sample.surface_cp,
        (VELOCITY_SAMPLE_DIMS.0 as u32, VELOCITY_SAMPLE_DIMS.1 as u32, VELOCITY_SAMPLE_DIMS.2 as u32),
        domain.min.into(),
        domain.max.into(),
        &sample.velocity_field.data,
    );
    let _ = tx.blocking_send(frame);
}
