use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use rekon_geometry::{AxisMapping, Mesh, Panel, Unit, VoxelGrid};
use tokio::sync::watch;

use crate::pipeline::RawImport;

pub struct MeshRecord {
    pub mesh_id: u64,
    /// Normalized into our wind-tunnel frame (see `rekon_geometry::frame`).
    pub mesh: Mesh,
    pub panels: Vec<Panel>,
    pub voxel_grid: VoxelGrid,
    /// `None` if the mesh's panel-method solve failed at import time (e.g. a
    /// degenerate/singular geometry) — see the warning pushed alongside it
    /// in that case. Live AoA/V/CG queries are simply unavailable then.
    pub panel_model: Option<rekon_panel::PanelModel>,
    pub warnings: Vec<String>,
    pub span_m: f32,
    pub chord_estimate_m: f32,
    pub thickness_estimate_m: f32,
    /// The pre-orientation import artifacts (repaired mesh, unit guess,
    /// inferred mapping) -- kept so `POST /api/mesh/orient` can rebuild with
    /// a different mapping/unit without re-uploading or re-repairing.
    pub raw: Arc<RawImport>,
    pub applied_mapping: AxisMapping,
    pub applied_unit: Unit,
}

#[derive(Clone)]
pub struct AppState {
    /// `None` until the first mesh is imported. A `watch` channel both notifies
    /// an already-connected WS client of a new import and immediately hands a
    /// freshly (re)connected client whatever the current mesh is.
    pub current_mesh: watch::Sender<Option<Arc<MeshRecord>>>,
    next_mesh_id: Arc<AtomicU64>,
    /// Bumped on every new `SolveFlowFieldRequest`; an in-flight solve's
    /// `should_stop` closure compares its own captured generation against
    /// this shared counter, so a new request cleanly supersedes whatever
    /// solve (if any) was already running, rather than racing it.
    pub solve_generation: Arc<AtomicU64>,
}

impl AppState {
    pub fn new() -> Self {
        let (current_mesh, _) = watch::channel(None);
        Self {
            current_mesh,
            next_mesh_id: Arc::new(AtomicU64::new(1)),
            solve_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn allocate_mesh_id(&self) -> u64 {
        self.next_mesh_id.fetch_add(1, Ordering::Relaxed)
    }
}
