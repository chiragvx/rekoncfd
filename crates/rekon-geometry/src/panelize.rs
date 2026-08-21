use glam::Vec3;

use crate::mesh::Mesh;

#[derive(Debug, Clone, Copy)]
pub struct Panel {
    pub vertices: [Vec3; 3],
    pub centroid: Vec3,
    /// Recomputed from vertex winding, never taken from the source STL's stored
    /// normal — see `Mesh::triangle_normal`.
    pub normal: Vec3,
    pub area: f32,
}

pub fn panelize(mesh: &Mesh) -> Vec<Panel> {
    mesh.triangles
        .iter()
        .map(|&tri| Panel {
            vertices: mesh.triangle_positions(tri),
            centroid: mesh.triangle_centroid(tri),
            normal: mesh.triangle_normal(tri),
            area: mesh.triangle_area(tri),
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
pub struct TeStrip {
    /// Center of this spanwise (Z-axis) bin.
    pub z_center: f32,
    pub leading_edge: Vec3,
    pub trailing_edge: Vec3,
}

/// First-pass trailing-edge detection: slice the mesh into `n_strips` bins along
/// the spanwise (Z, per `frame::infer_frame`'s convention) axis, and within each
/// bin take the chordwise (X) extrema as leading/trailing edge. This assumes a
/// reasonably clean single-surface wing — winglets, blended pods, or multi-panel
/// geometry can fool it, per the plan's known risk; a user-assisted override is
/// the intended fallback, not implemented here yet.
pub fn detect_trailing_edge_strips(mesh: &Mesh, n_strips: usize) -> Vec<TeStrip> {
    if mesh.vertices.is_empty() || n_strips == 0 {
        return Vec::new();
    }

    let bbox = mesh.bounding_box();
    let z_min = bbox.min.z;
    let z_span = (bbox.max.z - bbox.min.z).max(f32::EPSILON);
    let bin_of = |z: f32| -> usize {
        (((z - z_min) / z_span) * n_strips as f32)
            .floor()
            .clamp(0.0, (n_strips - 1) as f32) as usize
    };

    let mut leading: Vec<Option<Vec3>> = vec![None; n_strips];
    let mut trailing: Vec<Option<Vec3>> = vec![None; n_strips];

    for &v in &mesh.vertices {
        let bin = bin_of(v.z);
        if leading[bin].is_none_or(|le| v.x < le.x) {
            leading[bin] = Some(v);
        }
        if trailing[bin].is_none_or(|te| v.x > te.x) {
            trailing[bin] = Some(v);
        }
    }

    (0..n_strips)
        .filter_map(|i| {
            let le = leading[i]?;
            let te = trailing[i]?;
            let z_center = z_min + (i as f32 + 0.5) * (z_span / n_strips as f32);
            Some(TeStrip { z_center, leading_edge: le, trailing_edge: te })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panelize_computes_expected_area_and_normal() {
        let mesh = Mesh {
            vertices: vec![Vec3::ZERO, Vec3::X, Vec3::Y],
            triangles: vec![[0, 1, 2]],
        };
        let panels = panelize(&mesh);
        assert_eq!(panels.len(), 1);
        assert!((panels[0].area - 0.5).abs() < 1e-6);
        assert!(panels[0].normal.abs_diff_eq(Vec3::Z, 1e-6));
    }

    #[test]
    fn detects_le_te_on_simple_tapered_wing() {
        // A single spanwise strip: chord runs 0..1 in X, span runs 0..1 in Z.
        let mesh = Mesh {
            vertices: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 0.0, 1.0),
                Vec3::new(0.8, 0.0, 1.0),
            ],
            triangles: vec![[0, 1, 2], [1, 3, 2]],
        };
        let strips = detect_trailing_edge_strips(&mesh, 1);
        assert_eq!(strips.len(), 1);
        assert!((strips[0].leading_edge.x - 0.0).abs() < 1e-6);
        assert!((strips[0].trailing_edge.x - 1.0).abs() < 1e-6);
    }
}
