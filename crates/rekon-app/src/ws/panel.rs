use nalgebra::Vector3;
use rekon_geometry::Mesh;
use rekon_panel::{coefficients, find_trim, polar, surface_flow, Freestream, PanelError, PanelModel, TrimError};
use rekon_protocol::{encode_f32_frame, tags};

/// `[alpha_deg, v_inf, cg_x, cg_y, cg_z]` — see `web/src/net/protocol.ts`'s
/// `SliderUpdate` encoder.
pub struct SliderState {
    pub freestream: Freestream,
    pub cg: Vector3<f64>,
}

pub fn decode_slider_update(payload: &[f32]) -> Option<SliderState> {
    if payload.len() < 5 {
        return None;
    }
    Some(SliderState {
        freestream: Freestream { alpha_deg: payload[0] as f64, v_inf: payload[1] as f64 },
        cg: Vector3::new(payload[2] as f64, payload[3] as f64, payload[4] as f64),
    })
}

/// A reasonable starting point once a mesh loads, before the user has
/// touched any slider: level flight (alpha=0), a modest RC-flying-wing
/// cruise speed, CG at the quarter-chord (a conventional first guess ahead
/// of the usual neutral-point location for a simple flying wing).
pub fn default_slider_state(chord_estimate_m: f32) -> SliderState {
    SliderState {
        freestream: Freestream { alpha_deg: 0.0, v_inf: 15.0 },
        cg: Vector3::new(chord_estimate_m as f64 * 0.25, 0.0, 0.0),
    }
}

/// Solves at `state`, integrates coefficients about `state.cg`, and encodes
/// a `PanelResult` frame: `[cl, cd_induced, cm, cp_0, cp_1, ..., cp_{n_vertices-1}]`
/// (per-vertex Cp, averaged from the panels/triangles touching each vertex —
/// `Mesh::triangles` and `PanelModel`'s panels share the same order and
/// indexing, see `rekon_geometry::panelize`).
pub fn encode_panel_result(mesh: &Mesh, model: &PanelModel, state: &SliderState) -> Result<Vec<u8>, PanelError> {
    let result = model.solve(state.freestream)?;
    let flow = surface_flow(model, &result);
    let coeffs = coefficients(model, &result, &flow, state.cg);
    let vertex_cp = per_vertex_cp(mesh, &flow.cp);

    let mut payload = Vec::with_capacity(3 + vertex_cp.len());
    payload.push(coeffs.cl as f32);
    payload.push(coeffs.cd_induced as f32);
    payload.push(coeffs.cm as f32);
    payload.extend(vertex_cp);

    Ok(encode_f32_frame(tags::PANEL_RESULT, &payload))
}

/// Default trim search bracket -- generous enough for essentially any
/// reasonable flying-wing design without needing the client to specify one;
/// `find_trim` reports a clear `NoSignChange` error (surfaced to the client
/// as the failure payload below) if this doesn't bracket a trim point.
const DEFAULT_TRIM_ALPHA_LO_DEG: f64 = -20.0;
const DEFAULT_TRIM_ALPHA_HI_DEG: f64 = 20.0;
const TRIM_TOL_DEG: f64 = 0.05;
const TRIM_MAX_ITER: usize = 50;

/// `[alpha_lo_deg, alpha_hi_deg]`, or `None` to use the default bracket.
pub fn decode_trim_request(payload: &[f32]) -> Option<(f64, f64)> {
    if payload.len() < 2 {
        return None;
    }
    Some((payload[0] as f64, payload[1] as f64))
}

/// Runs `find_trim` about `state.cg` at `state.freestream.v_inf`, encoding
/// either a success payload `[1.0, alpha_deg, cl, cm, static_margin]` or (on
/// `NoSignChange`, the only error variant that isn't itself a solver
/// failure) a diagnostic failure payload `[0.0, alpha_lo, cm_lo, alpha_hi, cm_hi]`
/// so the client can show the user why no trim point was found. Any other
/// error (a genuine panel-method solve failure) is propagated, matching
/// `encode_panel_result`'s convention.
pub fn encode_trim_result(
    model: &PanelModel,
    state: &SliderState,
    bracket: Option<(f64, f64)>,
) -> Result<Vec<u8>, PanelError> {
    let (alpha_lo, alpha_hi) = bracket.unwrap_or((DEFAULT_TRIM_ALPHA_LO_DEG, DEFAULT_TRIM_ALPHA_HI_DEG));
    match find_trim(model, state.freestream.v_inf, state.cg, alpha_lo, alpha_hi, TRIM_TOL_DEG, TRIM_MAX_ITER) {
        Ok(trim) => {
            let payload = [1.0, trim.alpha_deg as f32, trim.cl as f32, trim.cm as f32, trim.static_margin as f32];
            Ok(encode_f32_frame(tags::TRIM_RESULT, &payload))
        }
        Err(TrimError::NoSignChange { alpha_lo, cm_lo, alpha_hi, cm_hi }) => {
            let payload = [0.0, alpha_lo as f32, cm_lo as f32, alpha_hi as f32, cm_hi as f32];
            Ok(encode_f32_frame(tags::TRIM_RESULT, &payload))
        }
        Err(TrimError::Panel(err)) => Err(err),
    }
}

/// `[alpha_min_deg, alpha_max_deg, n_points]`.
pub fn decode_polar_request(payload: &[f32]) -> Option<(f64, f64, usize)> {
    if payload.len() < 3 {
        return None;
    }
    let n_points = (payload[2] as usize).clamp(2, 200);
    Some((payload[0] as f64, payload[1] as f64, n_points))
}

/// Sweeps `polar` about `state.cg` at `state.freestream.v_inf` and encodes
/// `[n_points, alpha_0, cl_0, cd_induced_0, cm_0, alpha_1, ...]`.
pub fn encode_polar_curve(
    model: &PanelModel,
    state: &SliderState,
    alpha_min_deg: f64,
    alpha_max_deg: f64,
    n_points: usize,
) -> Result<Vec<u8>, PanelError> {
    let alphas: Vec<f64> = if n_points <= 1 {
        vec![alpha_min_deg]
    } else {
        let step = (alpha_max_deg - alpha_min_deg) / (n_points - 1) as f64;
        (0..n_points).map(|i| alpha_min_deg + step * i as f64).collect()
    };

    let points = polar(model, state.freestream.v_inf, state.cg, &alphas)?;

    let mut payload = Vec::with_capacity(1 + points.len() * 4);
    payload.push(points.len() as f32);
    for p in &points {
        payload.push(p.alpha_deg as f32);
        payload.push(p.coefficients.cl as f32);
        payload.push(p.coefficients.cd_induced as f32);
        payload.push(p.coefficients.cm as f32);
    }

    Ok(encode_f32_frame(tags::POLAR_CURVE, &payload))
}

fn per_vertex_cp(mesh: &Mesh, panel_cp: &[f64]) -> Vec<f32> {
    let mut sum = vec![0.0f64; mesh.vertices.len()];
    let mut count = vec![0u32; mesh.vertices.len()];
    for (tri, &cp) in mesh.triangles.iter().zip(panel_cp) {
        for &vertex_index in tri {
            sum[vertex_index as usize] += cp;
            count[vertex_index as usize] += 1;
        }
    }
    sum.iter()
        .zip(&count)
        .map(|(&s, &c)| if c > 0 { (s / c as f64) as f32 } else { 0.0 })
        .collect()
}
