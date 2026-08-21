pub mod frame;
pub mod mesh;
pub mod mesh_repair;
pub mod naca;
pub mod panelize;
pub mod stl_import;
pub mod units;
pub mod voxelizer;

pub use frame::{apply_frame, frame_from_mapping, infer_frame, AxisMapping, FrameInfo, FrameTransform, SignedAxis};
pub use mesh::{Aabb, Mesh};
pub use mesh_repair::{repair, RepairReport};
pub use naca::{generate_wing, Airfoil, AirfoilParseError, WingParamError, WingParams};
pub use panelize::{detect_trailing_edge_strips, panelize, Panel, TeStrip};
pub use stl_import::{import_stl, ImportError};
pub use units::{guess_unit, Unit, UnitGuess};
pub use voxelizer::{voxelize, VoxelGrid};

#[cfg(test)]
mod pipeline_tests {
    use super::*;
    use glam::Vec3;

    /// A closed box standing in for a flying wing: 1000mm span (X), 200mm chord
    /// (Z), 20mm thickness (Y) — deliberately NOT pre-aligned to our wind-tunnel
    /// convention, to exercise `infer_frame`'s axis-guessing.
    fn synthetic_wing_stl_box() -> Mesh {
        let v = |x: f32, y: f32, z: f32| Vec3::new(x, y, z);
        let vertices = vec![
            v(0.0, 0.0, 0.0), v(1000.0, 0.0, 0.0), v(1000.0, 20.0, 0.0), v(0.0, 20.0, 0.0),
            v(0.0, 0.0, 200.0), v(1000.0, 0.0, 200.0), v(1000.0, 20.0, 200.0), v(0.0, 20.0, 200.0),
        ];
        let triangles = vec![
            [0, 2, 1], [0, 3, 2],
            [4, 5, 6], [4, 6, 7],
            [0, 1, 5], [0, 5, 4],
            [3, 6, 2], [3, 7, 6],
            [0, 4, 7], [0, 7, 3],
            [1, 2, 6], [1, 6, 5],
        ];
        Mesh { vertices, triangles }
    }

    #[test]
    fn full_pipeline_runs_end_to_end_on_synthetic_wing() {
        let raw = synthetic_wing_stl_box();

        let (repaired, report) = repair(&raw, 1e-4);
        assert_eq!(report.open_edges, 0, "synthetic box should be watertight");
        assert_eq!(report.degenerate_removed, 0);

        let bbox = repaired.bounding_box();
        let unit_guess = guess_unit(&bbox);
        assert_eq!(unit_guess.unit, Unit::Millimeters);

        let frame_info = infer_frame(&repaired, unit_guess.unit);
        assert!((frame_info.span - 1.0).abs() < 1e-3, "span {} should be ~1m", frame_info.span);
        assert!((frame_info.chord_estimate - 0.2).abs() < 1e-3);
        assert!((frame_info.thickness_estimate - 0.02).abs() < 1e-3);

        let normalized = apply_frame(&repaired, &frame_info.transform);
        let panels = panelize(&normalized);
        assert_eq!(panels.len(), 12);

        let total_area: f32 = panels.iter().map(|p| p.area).sum();
        // Box surface area at 1m x 0.2m x 0.02m: 2*(1*0.2 + 1*0.02 + 0.2*0.02) = 0.448 m^2
        assert!((total_area - 0.448).abs() < 1e-3, "total panel area {total_area}");

        // The synthetic box only has vertices at its two spanwise extremes (no
        // interior stations), so with more bins than that most would come up
        // empty; 2 bins is what this fixture can actually populate.
        let strips = detect_trailing_edge_strips(&normalized, 2);
        assert_eq!(strips.len(), 2);

        // Margin is intentionally small on the thickness (Y) axis: this wing is
        // only 0.02m thick, so a uniform 0.5m margin at 20 cells would leave no
        // voxel center anywhere near the actual solid — real domain-sizing policy
        // belongs to the LBM setup (Phase 3B), this just needs to resolve the shape.
        let domain = normalized.bounding_box().expanded_by(Vec3::new(0.3, 0.05, 0.3));
        let grid = voxelize(&normalized, domain, (40, 20, 20));
        let occ = grid.occupancy_fraction();
        assert!(occ > 0.0 && occ < 1.0, "occupancy {occ} should be a partial fill of the domain");
    }
}
