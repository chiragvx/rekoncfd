use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rekon_geometry::{Airfoil, AxisMapping, SignedAxis, Unit, WingParams};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};

use crate::pipeline;
use crate::samples;
use crate::state::{AppState, MeshRecord};
use crate::updater;

/// The built frontend (`npm run build` in `web/`) is embedded into the binary at
/// compile time, so the release artifact is a single standalone `.exe` with no
/// separate Node/npm step required at runtime.
#[derive(RustEmbed)]
#[folder = "../../web/dist"]
struct FrontendAssets;

pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match FrontendAssets::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(Body::from(file.data.into_owned()))
                .unwrap()
        }
        // SPA fallback: unknown paths (client-side routes) still get index.html.
        None => match FrontendAssets::get("index.html") {
            Some(file) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html")
                .body(Body::from(file.data.into_owned()))
                .unwrap(),
            None => (StatusCode::NOT_FOUND, "frontend not built").into_response(),
        },
    }
}

#[derive(Serialize)]
pub(crate) struct AxisMappingResponse {
    chord: String,
    up: String,
    span: String,
}

#[derive(Serialize)]
pub(crate) struct ImportResponse {
    mesh_id: u64,
    vertex_count: usize,
    triangle_count: usize,
    panel_count: usize,
    bbox_min: [f32; 3],
    bbox_max: [f32; 3],
    span_m: f32,
    chord_estimate_m: f32,
    thickness_estimate_m: f32,
    voxel_occupancy: f32,
    warnings: Vec<String>,
    /// The unit CURRENTLY applied (may be a user override, not necessarily
    /// the auto-guess) -- one of "mm", "cm", "m", "in".
    unit: String,
    /// True only when the applied unit matches the original auto-guess AND
    /// that guess was itself confident -- an explicit user override always
    /// reads as "confident" here, since there's no guess left to doubt.
    unit_confident: bool,
    /// The currently applied axis mapping, e.g. `{chord:"+x", up:"+y", span:"+z"}`.
    mapping: AxisMappingResponse,
}

fn signed_axis_to_string(axis: SignedAxis) -> String {
    let letter = match axis.source_axis {
        0 => "x",
        1 => "y",
        2 => "z",
        _ => unreachable!("SignedAxis::source_axis is always 0, 1, or 2"),
    };
    format!("{}{}", if axis.sign < 0 { "-" } else { "+" }, letter)
}

fn unit_to_string(unit: Unit) -> &'static str {
    match unit {
        Unit::Meters => "m",
        Unit::Millimeters => "mm",
        Unit::Centimeters => "cm",
        Unit::Inches => "in",
    }
}

fn parse_signed_axis(s: &str) -> Option<SignedAxis> {
    let s = s.trim();
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1i8, &s[1..]),
        b'-' => (-1i8, &s[1..]),
        _ => (1i8, s),
    };
    let axis = match rest {
        "x" | "X" => 0,
        "y" | "Y" => 1,
        "z" | "Z" => 2,
        _ => return None,
    };
    Some(SignedAxis::new(axis, sign))
}

fn parse_unit(s: &str) -> Option<Unit> {
    match s {
        "mm" => Some(Unit::Millimeters),
        "cm" => Some(Unit::Centimeters),
        "m" => Some(Unit::Meters),
        "in" => Some(Unit::Inches),
        _ => None,
    }
}

fn response_for(record: &MeshRecord) -> ImportResponse {
    let bbox = record.mesh.bounding_box();
    ImportResponse {
        mesh_id: record.mesh_id,
        vertex_count: record.mesh.vertices.len(),
        triangle_count: record.mesh.triangles.len(),
        panel_count: record.panels.len(),
        bbox_min: bbox.min.into(),
        bbox_max: bbox.max.into(),
        span_m: record.span_m,
        chord_estimate_m: record.chord_estimate_m,
        thickness_estimate_m: record.thickness_estimate_m,
        voxel_occupancy: record.voxel_grid.occupancy_fraction(),
        warnings: record.warnings.clone(),
        unit: unit_to_string(record.applied_unit).to_string(),
        unit_confident: record.applied_unit == record.raw.unit_guess.unit && record.raw.unit_guess.confident,
        mapping: AxisMappingResponse {
            chord: signed_axis_to_string(record.applied_mapping.chord),
            up: signed_axis_to_string(record.applied_mapping.up),
            span: signed_axis_to_string(record.applied_mapping.span),
        },
    }
}

pub async fn import_mesh(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<ImportResponse>, (StatusCode, String)> {
    let mut stl_bytes: Option<Vec<u8>> = None;

    loop {
        let field = multipart
            .next_field()
            .await
            .map_err(|err| (StatusCode::BAD_REQUEST, format!("invalid multipart body: {err}")))?;
        let Some(field) = field else { break };

        if field.name() == Some("file") {
            let bytes = field
                .bytes()
                .await
                .map_err(|err| (StatusCode::BAD_REQUEST, format!("failed to read upload: {err}")))?;
            stl_bytes = Some(bytes.to_vec());
        }
    }

    let stl_bytes = stl_bytes
        .ok_or((StatusCode::BAD_REQUEST, "missing \"file\" field in multipart body".to_string()))?;

    let mesh_id = state.allocate_mesh_id();
    // The geometry pipeline (voxelizer, panel-method AIC assembly + LU
    // factorization) is CPU-bound and non-trivial for larger meshes — never
    // run it inline on the async runtime, which would stall every other
    // request/WS connection this server is handling.
    let record = tokio::task::spawn_blocking(move || pipeline::run(&stl_bytes, mesh_id))
        .await
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, format!("import task panicked: {err}")))?
        .map_err(|err| (StatusCode::UNPROCESSABLE_ENTITY, err.to_string()))?;

    let response = response_for(&record);

    // Fix latent bug D: bump solve_generation BEFORE current_mesh.send, so
    // an in-flight LBM solve exits via StoppedByCaller rather than later
    // delivering a stale SolveResult over this new mesh.
    state.solve_generation.fetch_add(1, Ordering::Relaxed);

    // Errors here only mean "no WS client is currently subscribed" (send on a
    // watch channel with zero receivers) — the value is still stored for any
    // client that connects/reconnects afterward, so it's fine to ignore.
    let _ = state.current_mesh.send(Some(Arc::new(record)));

    Ok(Json(response))
}

#[derive(Deserialize)]
pub(crate) struct OrientRequest {
    chord_axis: String,
    up_axis: String,
    span_axis: String,
    unit: String,
}

/// Rebuilds the currently-loaded mesh under a different axis mapping/unit
/// without re-uploading or re-repairing the STL. Requires a mesh to already
/// be loaded (404 otherwise) and 3 distinct source base axes plus a
/// recognized unit (400 otherwise).
pub async fn orient_mesh(
    State(state): State<AppState>,
    Json(req): Json<OrientRequest>,
) -> Result<Json<ImportResponse>, (StatusCode, String)> {
    let chord =
        parse_signed_axis(&req.chord_axis).ok_or((StatusCode::BAD_REQUEST, format!("invalid chord_axis {:?}", req.chord_axis)))?;
    let up = parse_signed_axis(&req.up_axis).ok_or((StatusCode::BAD_REQUEST, format!("invalid up_axis {:?}", req.up_axis)))?;
    let span =
        parse_signed_axis(&req.span_axis).ok_or((StatusCode::BAD_REQUEST, format!("invalid span_axis {:?}", req.span_axis)))?;
    let unit = parse_unit(&req.unit).ok_or((StatusCode::BAD_REQUEST, format!("invalid unit {:?}", req.unit)))?;

    let mut base_axes = [chord.source_axis, up.source_axis, span.source_axis];
    base_axes.sort_unstable();
    if base_axes[0] == base_axes[1] || base_axes[1] == base_axes[2] {
        return Err((
            StatusCode::BAD_REQUEST,
            "chord_axis, up_axis, and span_axis must reference 3 distinct source axes".to_string(),
        ));
    }
    let mapping = AxisMapping { chord, up, span };

    // Clone the Arc<RawImport> out of the watch borrow guard BEFORE any
    // await -- the guard isn't Send (same non-Send pattern as
    // ws/connection.rs's send_mesh).
    let raw = {
        let guard = state.current_mesh.borrow();
        guard.as_ref().map(|record| record.raw.clone())
    };
    let Some(raw) = raw else {
        return Err((StatusCode::NOT_FOUND, "no mesh has been imported yet".to_string()));
    };

    let mesh_id = state.allocate_mesh_id();
    let record = tokio::task::spawn_blocking(move || pipeline::finalize(raw, mapping, unit, mesh_id))
        .await
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, format!("orient task panicked: {err}")))?;

    let response = response_for(&record);

    // Fix latent bug D: bump solve_generation BEFORE current_mesh.send, so
    // an in-flight LBM solve exits via StoppedByCaller rather than later
    // delivering a stale SolveResult over this re-oriented mesh.
    state.solve_generation.fetch_add(1, Ordering::Relaxed);

    let _ = state.current_mesh.send(Some(Arc::new(record)));

    Ok(Json(response))
}

/// Clears the currently-loaded mesh (if any): no request/response body,
/// since there's nothing left to describe once cleared. Broadcasts over the
/// WS `current_mesh` watch channel, so every connected client (not just the
/// one that clicked "Clear") resets back to its no-mesh-loaded state — see
/// `ws::connection`'s handling of a `None` mesh.
pub async fn clear_mesh(State(state): State<AppState>) -> StatusCode {
    // Fix latent bug D (same pattern as import/orient): bump solve_generation
    // BEFORE sending, so an in-flight LBM solve exits via StoppedByCaller
    // rather than later delivering a stale SolveResult with no mesh to show it on.
    state.solve_generation.fetch_add(1, Ordering::Relaxed);
    let _ = state.current_mesh.send(None);
    StatusCode::NO_CONTENT
}

/// A newly-built mesh (from `/api/mesh/generate` or `/api/models/:id/load`)
/// replaces whatever's currently loaded and broadcasts over the same
/// `current_mesh` watch channel a real STL import uses — same latent-bug-D
/// fix (bump `solve_generation` first) applies here too.
fn publish_generated(state: &AppState, mesh: rekon_geometry::Mesh) -> ImportResponse {
    let mesh_id = state.allocate_mesh_id();
    let record = pipeline::run_generated(mesh, mesh_id);
    let response = response_for(&record);
    state.solve_generation.fetch_add(1, Ordering::Relaxed);
    let _ = state.current_mesh.send(Some(Arc::new(record)));
    response
}

#[derive(Deserialize)]
pub(crate) struct GenerateWingRequest {
    /// Bare NACA digit designation, e.g. "2412" or "23012" (no "NACA" prefix).
    naca: String,
    span_m: f32,
    root_chord_m: f32,
    tip_chord_m: f32,
    #[serde(default)]
    sweep_deg: f32,
    #[serde(default)]
    dihedral_deg: f32,
    #[serde(default)]
    washout_deg: f32,
    #[serde(default = "default_n_chord")]
    n_chord_stations: usize,
    #[serde(default = "default_n_span")]
    n_span_stations: usize,
}

// Chosen to stay comfortably under MAX_PANEL_METHOD_PANELS (see
// pipeline.rs) for a single wing half plus its mirror -- 18 chordwise x 14
// spanwise-per-half comes out to 1836 panels, leaving real headroom (vs.
// 24x18's 3220, which silently loses the live panel-method solve).
fn default_n_chord() -> usize {
    18
}

fn default_n_span() -> usize {
    14
}

/// Builds a wing mesh from NACA + planform parameters (the Airfoil
/// Generator's "Generate" action) and loads it as the current mesh, exactly
/// as if it had been imported from an STL file — same pipeline, same
/// warnings, same WS broadcast to any connected viewer.
pub async fn generate_wing(
    State(state): State<AppState>,
    Json(req): Json<GenerateWingRequest>,
) -> Result<Json<ImportResponse>, (StatusCode, String)> {
    let airfoil = Airfoil::parse_naca(&req.naca).map_err(|err| (StatusCode::BAD_REQUEST, err.to_string()))?;
    let params = WingParams {
        airfoil,
        span_m: req.span_m,
        root_chord_m: req.root_chord_m,
        tip_chord_m: req.tip_chord_m,
        sweep_deg: req.sweep_deg,
        dihedral_deg: req.dihedral_deg,
        washout_deg: req.washout_deg,
        n_chord_stations: req.n_chord_stations,
        n_span_stations: req.n_span_stations,
    };

    let mesh = tokio::task::spawn_blocking(move || rekon_geometry::generate_wing(&params))
        .await
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, format!("generate task panicked: {err}")))?
        .map_err(|err| (StatusCode::BAD_REQUEST, err.to_string()))?;

    let state_for_blocking = state.clone();
    let response = tokio::task::spawn_blocking(move || publish_generated(&state_for_blocking, mesh))
        .await
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, format!("finalize task panicked: {err}")))?;

    Ok(Json(response))
}

#[derive(Serialize)]
pub(crate) struct SampleModelSummary {
    id: String,
    name: String,
    description: String,
    tags: Vec<String>,
}

/// Lists the "Explore Models" catalog — see `samples::catalog` for what's in
/// it today (procedurally generated demo wings) and why.
pub async fn list_models() -> Json<Vec<SampleModelSummary>> {
    let summaries = samples::catalog()
        .into_iter()
        .map(|m| SampleModelSummary {
            id: m.id.to_string(),
            name: m.name.to_string(),
            description: m.description.to_string(),
            tags: m.tags.iter().map(|t| t.to_string()).collect(),
        })
        .collect();
    Json(summaries)
}

/// Loads one catalog entry as the current mesh (same effect as generating it
/// manually via the Airfoil Generator with that entry's exact parameters).
pub async fn load_model(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ImportResponse>, (StatusCode, String)> {
    let model = samples::find(&id).ok_or((StatusCode::NOT_FOUND, format!("no sample model {id:?}")))?;

    let mesh = tokio::task::spawn_blocking(move || rekon_geometry::generate_wing(&model.params))
        .await
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, format!("generate task panicked: {err}")))?
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;

    let state_for_blocking = state.clone();
    let response = tokio::task::spawn_blocking(move || publish_generated(&state_for_blocking, mesh))
        .await
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, format!("finalize task panicked: {err}")))?;

    Ok(Json(response))
}

/// Reports the running app's version and, best-effort, whether a newer
/// GitHub release exists -- see `updater::check_for_update` for why a
/// failed/unreachable check reads as "no update" rather than an HTTP error.
/// `self_update`'s HTTP calls are blocking, hence `spawn_blocking`.
pub async fn version_info() -> Json<updater::VersionInfo> {
    let info = tokio::task::spawn_blocking(updater::check_for_update)
        .await
        .unwrap_or_else(|err| {
            tracing::error!("version check task panicked: {err}");
            updater::VersionInfo {
                current: env!("CARGO_PKG_VERSION").to_string(),
                latest: None,
                update_available: false,
                release_notes: None,
            }
        });
    Json(info)
}

#[derive(Serialize)]
pub(crate) struct ApplyUpdateResponse {
    version: String,
}

/// Downloads and installs the latest release over the currently-running
/// exe. The caller (the desktop UI) is responsible for telling the user to
/// relaunch afterward -- this process keeps running the OLD code in memory
/// until it exits, and does not (and safely cannot) restart itself.
pub async fn apply_update() -> Result<Json<ApplyUpdateResponse>, (StatusCode, String)> {
    let version = tokio::task::spawn_blocking(updater::apply_update)
        .await
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, format!("update task panicked: {err}")))?
        .map_err(|err| (StatusCode::BAD_GATEWAY, err.to_string()))?;

    Ok(Json(ApplyUpdateResponse { version }))
}
