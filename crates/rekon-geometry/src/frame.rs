use glam::Vec3;

use crate::mesh::Mesh;
use crate::units::Unit;

/// Our wind-tunnel convention: X = streamwise (chordwise, nose->tail), Y = up
/// (vertical/thickness), Z = spanwise (left-right). STL files carry no axis
/// metadata, so `infer_frame` guesses which source axis is which from bbox
/// extents alone -- a heuristic, not a guarantee (nose direction, up
/// direction, and even which source axis is which cannot be recovered from
/// extents), which is why `AxisMapping`/`frame_from_mapping` below exist for
/// the user-driven override the UI exposes at `POST /api/mesh/orient`.
#[derive(Debug, Clone, Copy)]
pub struct FrameTransform {
    /// `axis_permutation[i]` = which source-mesh axis (0=x,1=y,2=z) becomes our axis `i`.
    pub axis_permutation: [usize; 3],
    /// `axis_signs[i]` = +1.0 or -1.0, applied to source axis `axis_permutation[i]`
    /// before it becomes our axis `i` -- lets a mapping flip nose/up/span
    /// direction independently of which source axis is chosen.
    pub axis_signs: [f32; 3],
    pub unit_scale: f32,
    /// Applied after permutation + sign + scale, so the transformed mesh is centered on origin.
    pub translation: Vec3,
}

impl FrameTransform {
    pub fn apply_point(&self, p: Vec3) -> Vec3 {
        let src = [p.x, p.y, p.z];
        Vec3::new(
            src[self.axis_permutation[0]] * self.axis_signs[0],
            src[self.axis_permutation[1]] * self.axis_signs[1],
            src[self.axis_permutation[2]] * self.axis_signs[2],
        ) * self.unit_scale
            - self.translation
    }

    /// True when this transform's linear part (permutation + signs) is
    /// orientation-reversing -- an odd permutation (e.g. swapping two
    /// axes) XOR an odd number of negative signs. `apply_frame` must flip
    /// triangle winding in that case, or every normal comes out inward
    /// (this mesh's `repair()` pass already fixed outward orientation
    /// BEFORE this transform runs, so nothing downstream re-corrects it).
    fn flips_winding(&self) -> bool {
        let permutation_sign = {
            let p = self.axis_permutation;
            let mut inversions = 0;
            for i in 0..3 {
                for j in (i + 1)..3 {
                    if p[i] > p[j] {
                        inversions += 1;
                    }
                }
            }
            if inversions % 2 == 0 { 1.0 } else { -1.0 }
        };
        let sign_product = self.axis_signs[0] * self.axis_signs[1] * self.axis_signs[2];
        permutation_sign * sign_product < 0.0
    }
}

/// One source-mesh axis (0=x, 1=y, 2=z), signed to indicate whether
/// increasing source-axis value should map to increasing (+1) or decreasing
/// (-1) target-axis value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignedAxis {
    pub source_axis: usize,
    pub sign: i8,
}

impl SignedAxis {
    pub fn new(source_axis: usize, sign: i8) -> Self {
        debug_assert!(source_axis < 3, "source_axis must be 0, 1, or 2");
        debug_assert!(sign == 1 || sign == -1, "sign must be +1 or -1");
        Self { source_axis, sign }
    }
}

/// A user- or heuristic-chosen mapping from the source STL's 3 axes to our
/// wind-tunnel convention (chord/X, up/Y, span/Z), each independently
/// signed. Building one from raw strings (e.g. "+z", "-x") and validating
/// that the three source axes are distinct is the caller's job (rekon-app's
/// HTTP layer) -- this crate has no serde dependency and stays that way.
#[derive(Debug, Clone, Copy)]
pub struct AxisMapping {
    pub chord: SignedAxis,
    pub up: SignedAxis,
    pub span: SignedAxis,
}

#[derive(Debug, Clone, Copy)]
pub struct FrameInfo {
    pub transform: FrameTransform,
    pub span: f32,
    pub chord_estimate: f32,
    pub thickness_estimate: f32,
}

/// Builds a `FrameInfo` from an explicit axis mapping: the general case
/// `infer_frame` (below) is a thin, all-positive-sign wrapper around.
/// Centering works the same way for both -- transform without translation
/// first, then re-center the transformed bbox on the origin.
pub fn frame_from_mapping(mapping: AxisMapping, unit: Unit, mesh: &Mesh) -> FrameInfo {
    let axis_permutation = [mapping.chord.source_axis, mapping.up.source_axis, mapping.span.source_axis];
    let axis_signs = [mapping.chord.sign as f32, mapping.up.sign as f32, mapping.span.sign as f32];
    let unit_scale = unit.to_meters_scale();

    let bbox = mesh.bounding_box();
    let size = bbox.size();
    let extents = [size.x, size.y, size.z];

    let transform_no_translation = FrameTransform {
        axis_permutation,
        axis_signs,
        unit_scale,
        translation: Vec3::ZERO,
    };
    let center = transform_no_translation.apply_point(bbox.center());

    let transform = FrameTransform {
        axis_permutation,
        axis_signs,
        unit_scale,
        translation: center,
    };

    FrameInfo {
        transform,
        span: extents[mapping.span.source_axis] * unit_scale,
        chord_estimate: extents[mapping.chord.source_axis] * unit_scale,
        thickness_estimate: extents[mapping.up.source_axis] * unit_scale,
    }
}

/// Infers the axis mapping by assuming the largest bbox extent is span, the
/// smallest is thickness, and the remainder is chord -- true for essentially
/// every flying-wing planform, but a heuristic, not a guarantee for unusual
/// geometry (e.g. very high-aspect-ratio winglets could confuse this).
/// Always picks positive signs: nose/up direction genuinely can't be
/// recovered from bbox extents alone, so this is a starting point for the
/// user-driven override (`frame_from_mapping`), not a claim of correctness.
pub fn infer_frame(mesh: &Mesh, unit: Unit) -> FrameInfo {
    let bbox = mesh.bounding_box();
    let size = bbox.size();
    let extents = [size.x, size.y, size.z];

    let mut axes_by_extent: [usize; 3] = [0, 1, 2];
    axes_by_extent.sort_by(|&a, &b| extents[b].partial_cmp(&extents[a]).unwrap());
    let (span_axis, chord_axis, thickness_axis) =
        (axes_by_extent[0], axes_by_extent[1], axes_by_extent[2]);

    let mapping = AxisMapping {
        chord: SignedAxis::new(chord_axis, 1),
        up: SignedAxis::new(thickness_axis, 1),
        span: SignedAxis::new(span_axis, 1),
    };
    frame_from_mapping(mapping, unit, mesh)
}

pub fn apply_frame(mesh: &Mesh, transform: &FrameTransform) -> Mesh {
    let vertices = mesh.vertices.iter().map(|&v| transform.apply_point(v)).collect();
    let triangles = if transform.flips_winding() {
        mesh.triangles.iter().map(|&[a, b, c]| [a, c, b]).collect()
    } else {
        mesh.triangles.clone()
    };
    Mesh { vertices, triangles }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_mesh(span: f32, chord: f32, thickness: f32) -> Mesh {
        // A flat box already in millimeters (arbitrary) and NOT axis-aligned to our
        // convention: source X is span-like (largest), source Z is chord-like.
        let vertices = vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(span, 0.0, 0.0),
            Vec3::new(span, thickness, 0.0),
            Vec3::new(0.0, thickness, 0.0),
            Vec3::new(0.0, 0.0, chord),
            Vec3::new(span, 0.0, chord),
            Vec3::new(span, thickness, chord),
            Vec3::new(0.0, thickness, chord),
        ];
        Mesh { vertices, triangles: vec![] }
    }

    /// A unit cube, outward-oriented (every face's right-hand-rule normal
    /// points away from the center, giving a POSITIVE signed volume) --
    /// this is the "already repaired" state `apply_frame` always receives
    /// in the real pipeline, and `flips_winding` must preserve it across a
    /// mirroring transform.
    fn unit_cube_mesh() -> Mesh {
        let v = |x: f32, y: f32, z: f32| Vec3::new(x, y, z);
        let vertices = vec![
            v(0.0, 0.0, 0.0),
            v(1.0, 0.0, 0.0),
            v(1.0, 1.0, 0.0),
            v(0.0, 1.0, 0.0),
            v(0.0, 0.0, 1.0),
            v(1.0, 0.0, 1.0),
            v(1.0, 1.0, 1.0),
            v(0.0, 1.0, 1.0),
        ];
        let triangles = vec![
            [0, 2, 1], [0, 3, 2], // bottom (z=0), normal -Z
            [4, 5, 6], [4, 6, 7], // top (z=1), normal +Z
            [0, 1, 5], [0, 5, 4], // front (y=0), normal -Y
            [3, 6, 2], [3, 7, 6], // back (y=1), normal +Y
            [0, 7, 3], [0, 4, 7], // left (x=0), normal -X
            [1, 2, 6], [1, 6, 5], // right (x=1), normal +X
        ];
        Mesh { vertices, triangles }
    }

    /// Divergence-theorem signed volume: positive iff the mesh is
    /// consistently outward-wound.
    fn signed_volume(mesh: &Mesh) -> f32 {
        mesh.triangles
            .iter()
            .map(|&tri| {
                let [a, b, c] = mesh.triangle_positions(tri);
                a.dot(b.cross(c)) / 6.0
            })
            .sum()
    }

    #[test]
    fn infers_largest_extent_as_span() {
        let mesh = box_mesh(1000.0, 200.0, 20.0); // millimeters
        let info = infer_frame(&mesh, Unit::Millimeters);
        assert!((info.span - 1.0).abs() < 1e-4);
        assert!((info.chord_estimate - 0.2).abs() < 1e-4);
        assert!((info.thickness_estimate - 0.02).abs() < 1e-4);
    }

    #[test]
    fn transform_centers_mesh_on_origin() {
        let mesh = box_mesh(1000.0, 200.0, 20.0);
        let info = infer_frame(&mesh, Unit::Millimeters);
        let transformed = apply_frame(&mesh, &info.transform);
        let center = transformed.bounding_box().center();
        assert!(center.length() < 1e-4);
    }

    #[test]
    fn odd_permutation_with_positive_signs_still_yields_outward_normals() {
        let mesh = unit_cube_mesh();
        assert!(signed_volume(&mesh) > 0.0, "fixture itself must be outward-oriented");

        // Swap X and Z (an odd, mirroring permutation) with all-positive signs.
        let mapping = AxisMapping {
            chord: SignedAxis::new(2, 1), // target X <- source Z
            up: SignedAxis::new(1, 1),
            span: SignedAxis::new(0, 1), // target Z <- source X
        };
        let info = frame_from_mapping(mapping, Unit::Meters, &mesh);
        let transformed = apply_frame(&mesh, &info.transform);
        assert!(
            signed_volume(&transformed) > 0.0,
            "an odd permutation should still produce outward-facing normals (winding must flip)"
        );
    }

    #[test]
    fn even_permutation_with_one_negative_sign_still_yields_outward_normals() {
        let mesh = unit_cube_mesh();

        // Identity permutation (even) with one axis sign flipped -- also a mirror.
        let mapping = AxisMapping {
            chord: SignedAxis::new(0, -1),
            up: SignedAxis::new(1, 1),
            span: SignedAxis::new(2, 1),
        };
        let info = frame_from_mapping(mapping, Unit::Meters, &mesh);
        let transformed = apply_frame(&mesh, &info.transform);
        assert!(
            signed_volume(&transformed) > 0.0,
            "a single negative sign should still produce outward-facing normals (winding must flip)"
        );
    }

    #[test]
    fn unit_override_scales_span_as_expected() {
        let mesh = box_mesh(1000.0, 200.0, 20.0);
        let mapping = AxisMapping {
            chord: SignedAxis::new(2, 1),
            up: SignedAxis::new(1, 1),
            span: SignedAxis::new(0, 1),
        };
        let info_mm = frame_from_mapping(mapping, Unit::Millimeters, &mesh);
        let info_m = frame_from_mapping(mapping, Unit::Meters, &mesh);
        // Same raw coordinates interpreted as millimeters read 1000x smaller
        // in meters than the same coordinates interpreted as already-meters.
        assert!((info_mm.span * 1000.0 - info_m.span).abs() < 1e-3);
    }

    #[test]
    fn frame_from_mapping_round_trips_against_infer_frame_for_identity() {
        let mesh = box_mesh(1000.0, 200.0, 20.0);
        let inferred = infer_frame(&mesh, Unit::Millimeters);

        // Rebuild the SAME mapping infer_frame chose (all positive signs)
        // explicitly, and confirm frame_from_mapping reproduces it exactly.
        let mapping = AxisMapping {
            chord: SignedAxis::new(inferred.transform.axis_permutation[0], 1),
            up: SignedAxis::new(inferred.transform.axis_permutation[1], 1),
            span: SignedAxis::new(inferred.transform.axis_permutation[2], 1),
        };
        let rebuilt = frame_from_mapping(mapping, Unit::Millimeters, &mesh);
        assert_eq!(rebuilt.transform.axis_permutation, inferred.transform.axis_permutation);
        assert_eq!(rebuilt.transform.axis_signs, inferred.transform.axis_signs);
        assert!((rebuilt.span - inferred.span).abs() < 1e-4);
        assert!((rebuilt.chord_estimate - inferred.chord_estimate).abs() < 1e-4);
    }
}
