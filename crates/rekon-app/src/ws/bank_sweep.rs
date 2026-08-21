//! "Banked flight" animation: N discrete frames sweeping alpha and bank
//! angle together, each one a REAL re-solve on the mesh rotated to that
//! frame's bank angle -- not a cosmetic render-time rotation layered on one
//! fixed solve. This is genuinely expensive: unlike alpha (which only
//! changes the panel method's right-hand side, reusing one cached
//! factorization -- see `rekon_panel::trim`), rotating the GEOMETRY changes
//! every panel's position and normal, so the AIC matrix has to be
//! refactored from scratch every frame, and the LBM flow field needs a full
//! re-solve on the rotated voxelization too. `decode_request` clamps
//! `n_frames` accordingly -- this is a "few minutes for the whole batch"
//! feature, not a "few milliseconds per frame" one.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use rekon_geometry::panelize;
use rekon_panel::{coefficients, surface_flow, Freestream, PanelConfig, PanelModel, ReferenceQuantities};
use rekon_protocol::{encode_f32_frame, tags};
use tokio::sync::mpsc::Sender;

use crate::pipeline;
use crate::state::MeshRecord;
use crate::ws::lbm::{run_lbm_to_completion, LbmFrameResult, LbmRunError};
use crate::ws::panel::{per_vertex_cp, SliderState};

pub struct BankSweepRequest {
    pub alpha_min_deg: f64,
    pub alpha_max_deg: f64,
    pub bank_min_deg: f32,
    pub bank_max_deg: f32,
    pub n_frames: usize,
}

/// `[alpha_min_deg, alpha_max_deg, bank_min_deg, bank_max_deg, n_frames]`.
/// `n_frames` is clamped to 3-16: at a rough 5-15s per frame (fresh panel
/// factorization + a full ~400-step LBM run), that keeps the whole batch
/// within a few minutes even in the worst case.
pub fn decode_request(payload: &[f32]) -> Option<BankSweepRequest> {
    if payload.len() < 5 {
        return None;
    }
    let n_frames = (payload[4] as usize).clamp(3, 16);
    Some(BankSweepRequest {
        alpha_min_deg: payload[0] as f64,
        alpha_max_deg: payload[1] as f64,
        bank_min_deg: payload[2],
        bank_max_deg: payload[3],
        n_frames,
    })
}

fn encode_frame(
    frame_index: usize,
    n_frames: usize,
    alpha_deg: f64,
    bank_deg: f32,
    cl: f64,
    cd_induced: f64,
    cm: f64,
    vertex_cp: &[f32],
    lbm: &LbmFrameResult,
) -> Vec<u8> {
    let (nx, ny, nz) = lbm.vel_dims;
    let mut payload = Vec::with_capacity(13 + vertex_cp.len() + lbm.velocity.len());
    payload.push(frame_index as f32);
    payload.push(n_frames as f32);
    payload.push(alpha_deg as f32);
    payload.push(bank_deg);
    payload.push(cl as f32);
    payload.push(cd_induced as f32);
    payload.push(cm as f32);
    payload.push(vertex_cp.len() as f32);
    payload.push(nx as f32);
    payload.push(ny as f32);
    payload.push(nz as f32);
    payload.extend(lbm.domain_min);
    payload.extend(lbm.domain_max);
    payload.extend_from_slice(vertex_cp);
    payload.extend(&lbm.velocity);

    encode_f32_frame(tags::MULTI_BANK_SWEEP_FRAME, &payload)
}

/// Runs the whole batch, streaming one `MULTI_BANK_SWEEP_FRAME` per
/// completed frame (plus interleaved `SOLVE_PROGRESS` during each frame's
/// LBM run) through `tx`. Checks `generation` before starting each frame AND
/// inside each frame's LBM run, so a newer request (or a mesh reorient/
/// clear, which also bumps `solve_generation`) cleanly cancels an in-flight
/// batch rather than racing it. Must run inside `spawn_blocking`.
pub fn run(
    record: Arc<MeshRecord>,
    slider: SliderState,
    request: BankSweepRequest,
    generation: u64,
    current_generation: Arc<AtomicU64>,
    tx: Sender<Vec<u8>>,
) {
    let base_mesh = &record.mesh;
    let chord_m = record.chord_estimate_m;
    let n = request.n_frames.max(1);

    // Computed ONCE from the ORIGINAL (unrotated) mesh and reused for every
    // frame -- both fix real bugs a naive "just rebuild everything on the
    // rotated mesh" approach would have:
    //
    // 1. `ReferenceQuantities::from_mesh`'s "planform area" is the sum of
    //    each panel's area weighted by `|normal.y|`, and its "span" is the
    //    bbox Z-extent -- both only mean "the wing's actual planform area/
    //    span" when the wing is in its normal orientation. Recomputed fresh
    //    on a mesh rotated toward bank=90, where the wing presents almost no
    //    `|normal.y|` at all, they'd silently shrink -- corrupting the very
    //    denominator CL/CD/Cm are normalized by and making coefficients
    //    incomparable across bank angles (a real aircraft's wing area
    //    doesn't change just because it's banked).
    // 2. The LBM domain must stay a fixed box across the whole animation, or
    //    the wind-tunnel wireframe visibly resizes every frame -- see
    //    `pipeline::bank_invariant_domain`'s doc comment.
    let base_panels = panelize(base_mesh);
    let fixed_reference = ReferenceQuantities::from_mesh(base_mesh, &base_panels);
    let domain = pipeline::bank_invariant_domain(base_mesh, chord_m.max(0.05) * 4.0);

    for i in 0..n {
        if current_generation.load(Ordering::Relaxed) != generation {
            return; // superseded by a newer request/reorient/clear
        }

        let t = if n <= 1 { 0.0 } else { i as f64 / (n - 1) as f64 };
        let alpha_deg = request.alpha_min_deg + (request.alpha_max_deg - request.alpha_min_deg) * t;
        let bank_deg = request.bank_min_deg + (request.bank_max_deg - request.bank_min_deg) * (t as f32);

        let rotated = base_mesh.rotated_around_x(bank_deg);

        let panel_config = PanelConfig { fixed_reference: Some(fixed_reference), ..PanelConfig::default() };
        let panel_model = match PanelModel::build(&rotated, panel_config) {
            Ok(m) => m,
            Err(err) => {
                tracing::warn!(frame = i, bank_deg, %err, "bank-sweep frame's panel model failed to build, skipping frame");
                continue;
            }
        };
        let result = match panel_model.solve(Freestream { alpha_deg, v_inf: slider.freestream.v_inf }) {
            Ok(r) => r,
            Err(err) => {
                tracing::warn!(frame = i, bank_deg, %err, "bank-sweep frame's panel solve failed, skipping frame");
                continue;
            }
        };
        let flow = surface_flow(&panel_model, &result);
        let coeffs = coefficients(&panel_model, &result, &flow, slider.cg);
        let vertex_cp = per_vertex_cp(&rotated, &flow.cp);

        let tx_progress = tx.clone();
        let current_gen_check = current_generation.clone();
        let lbm_result = run_lbm_to_completion(
            &rotated,
            domain,
            chord_m,
            alpha_deg,
            slider.freestream.v_inf,
            move |p| {
                let payload = [p.step as f32, p.max_steps as f32, p.max_velocity, p.mean_density];
                let _ = tx_progress.try_send(encode_f32_frame(tags::SOLVE_PROGRESS, &payload));
            },
            move || current_gen_check.load(Ordering::Relaxed) != generation,
        );

        let lbm = match lbm_result {
            Ok(r) => r,
            Err(LbmRunError::StoppedByCaller) => return,
            Err(LbmRunError::Diverged) => {
                tracing::warn!(frame = i, bank_deg, "bank-sweep frame's LBM solve diverged, skipping frame");
                continue;
            }
            Err(LbmRunError::Solver(err)) => {
                tracing::warn!(frame = i, bank_deg, %err, "bank-sweep frame's LBM solver failed to configure, skipping frame");
                continue;
            }
        };

        let frame_bytes = encode_frame(i, n, alpha_deg, bank_deg, coeffs.cl, coeffs.cd_induced, coeffs.cm, &vertex_cp, &lbm);
        if tx.blocking_send(frame_bytes).is_err() {
            return; // client disconnected
        }
    }
}
