use std::io::Cursor;
use std::sync::Arc;

use glam::Vec3;
use rekon_geometry::{
    apply_frame, detect_trailing_edge_strips, frame_from_mapping, guess_unit, import_stl,
    infer_frame, panelize, repair, voxelize, Aabb, AxisMapping, ImportError, Mesh, RepairReport,
    SignedAxis, Unit, UnitGuess,
};
use thiserror::Error;

use crate::state::MeshRecord;

#[derive(Debug, Error)]
pub enum PipelineError {
    #[error(transparent)]
    Import(#[from] ImportError),
}

/// Default wind-tunnel voxel grid resolution for the on-import preview. The real
/// Phase 3B solve setup gets its own (likely user-tunable) sizing; this exists so
/// Phase 2 has a real `VoxelGrid` in `AppState` and can log a sanity-checkable
/// occupancy fraction.
const DEFAULT_VOXEL_DIMS: (usize, usize, usize) = (128, 64, 64);

/// The panel method's AIC assembly is O(n^2) (each entry its own adaptive
/// quadrature) and its system-matrix factorization is O(n^3) -- measured
/// (release build) at 2.1s/2128 panels, 21.0s/4104 panels, 166.8s/8056
/// panels, matching that cubic scaling almost exactly. A "tens of
/// thousands of panels" mesh -- an easy STL triangle count for anything
/// beyond a simple test wing -- extrapolates to HOURS. There's no progress
/// reporting on this path (it's one synchronous call inside
/// `spawn_blocking`), so past this cap the import request would just hang
/// with no error rather than fail fast. Skipping the live solve above the
/// cap keeps import responsive (worst case ~10s, per the measurements
/// above) regardless of mesh complexity; the mesh itself (view + voxelize +
/// the on-demand LBM solve, which runs on a fixed-resolution grid
/// independent of triangle count) stays fully usable either way.
const MAX_PANEL_METHOD_PANELS: usize = 3000;

/// The result of the cheap, orientation-independent half of the pipeline
/// (parse + repair + heuristics) -- kept around per mesh so `POST
/// /api/mesh/orient` can rebuild with a different axis mapping/unit
/// without re-uploading or re-repairing the STL.
pub struct RawImport {
    pub repaired: Mesh,
    pub repair_report: RepairReport,
    pub unit_guess: UnitGuess,
    /// `infer_frame`'s heuristic mapping (always positive signs) -- the
    /// starting point `finalize` uses by default, and what the orientation
    /// UI initially shows before any user override.
    pub inferred_mapping: AxisMapping,
}

/// Import + repair + unit/orientation heuristics only -- cheap relative to
/// `finalize`, and independent of which axis mapping/unit ultimately gets
/// applied.
pub fn import_raw(stl_bytes: &[u8]) -> Result<RawImport, PipelineError> {
    let mut cursor = Cursor::new(stl_bytes);
    let raw = import_stl(&mut cursor)?;

    // Weld tolerance as a fraction of the raw model's own extent, since we don't
    // yet know whether it's authored in millimeters or meters.
    let raw_extent = raw.bounding_box().size().max_element();
    let weld_epsilon = raw_extent * 1e-5;
    let (repaired, repair_report) = repair(&raw, weld_epsilon);

    let unit_guess = guess_unit(&repaired.bounding_box());
    let inferred = infer_frame(&repaired, unit_guess.unit);
    let inferred_mapping = AxisMapping {
        chord: SignedAxis::new(inferred.transform.axis_permutation[0], 1),
        up: SignedAxis::new(inferred.transform.axis_permutation[1], 1),
        span: SignedAxis::new(inferred.transform.axis_permutation[2], 1),
    };

    Ok(RawImport { repaired, repair_report, unit_guess, inferred_mapping })
}

/// The expensive half of the pipeline (frame normalize -> panelize ->
/// voxelize -> panel-method AIC assembly + LU factorization) -- always
/// CPU-bound enough that callers must run this via `spawn_blocking`.
pub fn finalize(raw: Arc<RawImport>, mapping: AxisMapping, unit: Unit, mesh_id: u64) -> MeshRecord {
    let frame_info = frame_from_mapping(mapping, unit, &raw.repaired);
    let normalized = apply_frame(&raw.repaired, &frame_info.transform);

    let panels = panelize(&normalized);
    let te_strips = detect_trailing_edge_strips(&normalized, 20);

    let domain = default_wind_tunnel_domain(&normalized, frame_info.span);
    let voxel_grid = voxelize(&normalized, domain, DEFAULT_VOXEL_DIMS);

    let mut warnings = Vec::new();

    let panel_model = if panels.len() > MAX_PANEL_METHOD_PANELS {
        warnings.push(format!(
            "mesh has {} panels, over the {}-panel limit for the live panel-method solve (its dense linear solve doesn't scale past this) — surface pressure/CL/CD/Cm are unavailable for this mesh, but viewing and the on-demand flow-field solve still work; simplify the STL to enable it",
            panels.len(),
            MAX_PANEL_METHOD_PANELS
        ));
        None
    } else {
        match rekon_panel::PanelModel::build(&normalized, rekon_panel::PanelConfig::default()) {
            Ok(model) => Some(model),
            Err(err) => {
                warnings.push(format!("panel-method solve unavailable for this mesh: {err}"));
                None
            }
        }
    };

    // Only relevant when the CURRENTLY APPLIED unit is the one that was
    // guessed -- a user who explicitly picked a different unit has already
    // made their own deliberate choice, so the auto-guess's confidence (or
    // lack of it) has nothing left to warn about.
    if unit == raw.unit_guess.unit && !raw.unit_guess.confident {
        warnings.push(format!(
            "unit detection is low-confidence (guessed {:?}) — verify scale before trusting results",
            raw.unit_guess.unit
        ));
    }
    if raw.repair_report.open_edges > 0 {
        warnings.push(format!(
            "mesh has {} open edge(s) — not watertight, voxelizer results near those gaps may be unreliable",
            raw.repair_report.open_edges
        ));
    }
    if te_strips.len() < 4 {
        warnings.push(
            "trailing-edge detection found very few spanwise stations — panel-method wake modeling may be unreliable for this geometry".to_string(),
        );
    }

    tracing::info!(
        mesh_id,
        vertices = normalized.vertices.len(),
        triangles = normalized.triangles.len(),
        panels = panels.len(),
        open_edges = raw.repair_report.open_edges,
        vertices_welded = raw.repair_report.vertices_welded,
        degenerate_removed = raw.repair_report.degenerate_removed,
        voxel_occupancy = voxel_grid.occupancy_fraction(),
        span_m = frame_info.span,
        "mesh finalized"
    );

    MeshRecord {
        mesh_id,
        mesh: normalized,
        panels,
        voxel_grid,
        panel_model,
        warnings,
        span_m: frame_info.span,
        chord_estimate_m: frame_info.chord_estimate,
        thickness_estimate_m: frame_info.thickness_estimate,
        raw,
        applied_mapping: mapping,
        applied_unit: unit,
    }
}

/// Runs the whole geometry pipeline (import -> repair -> unit guess -> frame
/// normalize -> panelize -> voxelize) on raw STL bytes and assembles a
/// `MeshRecord`, using the auto-inferred axis mapping and guessed unit.
pub fn run(stl_bytes: &[u8], mesh_id: u64) -> Result<MeshRecord, PipelineError> {
    let raw = Arc::new(import_raw(stl_bytes)?);
    let mapping = raw.inferred_mapping;
    let unit = raw.unit_guess.unit;
    Ok(finalize(raw, mapping, unit, mesh_id))
}

/// Runs a mesh built directly by the geometry generators (NACA airfoil/wing,
/// and any future sample catalog entries) through the same repair + finalize
/// path a real STL upload gets. The generator already builds in our
/// wind-tunnel convention (X=chord, Y=up, Z=span) and in meters, so the
/// mapping/unit here are always identity/`Meters` -- there's no orientation
/// or scale to guess.
pub fn run_generated(mesh: Mesh, mesh_id: u64) -> MeshRecord {
    let raw_extent = mesh.bounding_box().size().max_element();
    let weld_epsilon = raw_extent * 1e-5;
    let (repaired, repair_report) = repair(&mesh, weld_epsilon);

    let identity_mapping = AxisMapping {
        chord: SignedAxis::new(0, 1),
        up: SignedAxis::new(1, 1),
        span: SignedAxis::new(2, 1),
    };
    let unit_guess = UnitGuess { unit: Unit::Meters, confident: true };
    let raw = Arc::new(RawImport { repaired, repair_report, unit_guess, inferred_mapping: identity_mapping });

    finalize(raw, identity_mapping, Unit::Meters, mesh_id)
}

/// A default wind-tunnel domain around the normalized mesh: generous margin
/// upstream/downstream (X) for inflow settling and wake development, modest
/// margin vertically (Y) and spanwise (Z). Real LBM domain-sizing policy
/// (Phase 3B) may override this; this default only needs to be sane for the
/// Phase 2 import-time preview.
pub(crate) fn default_wind_tunnel_domain(mesh: &Mesh, span: f32) -> Aabb {
    let bbox = mesh.bounding_box();
    let margin = Vec3::new(span * 0.6, span * 0.3, span * 0.15).max(Vec3::splat(0.05));
    bbox.expanded_by(margin)
}

/// A wind-tunnel domain sized to stay valid across ANY rotation around the
/// X (flow) axis -- unlike `default_wind_tunnel_domain`, whose Y/Z margins
/// are added to the mesh's own (rotation-DEPENDENT) bbox extents, so a
/// domain sized from a rotated mesh comes out a different shape than one
/// sized from the original.
///
/// Used by the bank-sweep animation, which computes this ONCE from the
/// original (unrotated) mesh and reuses the identical domain for every
/// frame's voxelization -- see `ws::bank_sweep`'s doc comment for why the
/// domain must stay fixed across bank angles rather than being resized per
/// frame.
pub(crate) fn bank_invariant_domain(mesh: &Mesh, span: f32) -> Aabb {
    let bbox = mesh.bounding_box();
    let center = bbox.center();
    // Max distance from the X axis through the mesh's own bbox center --
    // rotation-invariant, so a domain built from it fits the mesh at any
    // bank angle, not just its current (bank=0) orientation.
    let reach = mesh
        .vertices
        .iter()
        .map(|v| {
            let dy = v.y - center.y;
            let dz = v.z - center.z;
            (dy * dy + dz * dz).sqrt()
        })
        .fold(0.0f32, f32::max);

    let x_margin = (span * 0.6).max(0.05);
    let yz_half_extent = (reach + span * 0.3).max(0.05);

    Aabb {
        min: Vec3::new(bbox.min.x - x_margin, center.y - yz_half_extent, center.z - yz_half_extent),
        max: Vec3::new(bbox.max.x + x_margin, center.y + yz_half_extent, center.z + yz_half_extent),
    }
}

#[cfg(test)]
mod domain_tests {
    use super::*;
    use rekon_geometry::Mesh;

    fn flat_wing_mesh(span: f32, chord: f32, thickness: f32) -> Mesh {
        let v = |x: f32, y: f32, z: f32| Vec3::new(x, y, z);
        Mesh {
            vertices: vec![
                v(0.0, -thickness / 2.0, -span / 2.0),
                v(chord, -thickness / 2.0, -span / 2.0),
                v(chord, thickness / 2.0, -span / 2.0),
                v(0.0, thickness / 2.0, -span / 2.0),
                v(0.0, -thickness / 2.0, span / 2.0),
                v(chord, -thickness / 2.0, span / 2.0),
                v(chord, thickness / 2.0, span / 2.0),
                v(0.0, thickness / 2.0, span / 2.0),
            ],
            triangles: vec![],
        }
    }

    #[test]
    fn bank_invariant_domain_has_same_size_regardless_of_mesh_rotation() {
        let mesh = flat_wing_mesh(1.2, 0.25, 0.02);
        let rotated = mesh.rotated_around_x(37.0);

        let size_a = bank_invariant_domain(&mesh, 0.25 * 4.0).size();
        let size_b = bank_invariant_domain(&rotated, 0.25 * 4.0).size();

        assert!((size_a.x - size_b.x).abs() < 1e-4, "X extent should match: {size_a:?} vs {size_b:?}");
        assert!((size_a.y - size_b.y).abs() < 1e-4, "Y extent should match: {size_a:?} vs {size_b:?}");
        assert!((size_a.z - size_b.z).abs() < 1e-4, "Z extent should match: {size_a:?} vs {size_b:?}");
    }

    #[test]
    fn bank_invariant_domain_contains_the_mesh_at_every_rotation() {
        // The real usage pattern: compute the domain ONCE from the original
        // mesh, then reuse it for every bank-rotated frame -- it must still
        // fully contain the mesh no matter how far that frame is rotated.
        let mesh = flat_wing_mesh(1.2, 0.25, 0.02);
        let domain = bank_invariant_domain(&mesh, 0.25 * 4.0);

        for degrees in [0.0, 15.0, 45.0, 90.0, 135.0, 180.0] {
            let rotated = mesh.rotated_around_x(degrees);
            for v in &rotated.vertices {
                assert!(
                    v.x >= domain.min.x && v.x <= domain.max.x && v.y >= domain.min.y && v.y <= domain.max.y && v.z >= domain.min.z && v.z <= domain.max.z,
                    "vertex {v:?} at {degrees} degrees bank falls outside the fixed domain {domain:?}"
                );
            }
        }
    }
}
