use glam::Vec3;

/// Indexed triangle mesh shared by the STL import, repair, panelizer, and voxelizer stages.
#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub vertices: Vec<Vec3>,
    /// Each triangle is three indices into `vertices`.
    pub triangles: Vec<[u32; 3]>,
}

impl Mesh {
    /// Rigid rotation of every vertex around the X axis (this crate's fixed
    /// flow/chordwise direction) by `degrees` -- e.g. the sweep animation's
    /// "bank angle", which needs a REAL rotated mesh (re-panelized,
    /// re-voxelized, re-solved) rather than a cosmetic render-time
    /// transform, since a pure viewport rotation can't change what the
    /// solver actually computed. Winding/normals need no separate
    /// correction: a rotation about a single axis is always
    /// orientation-preserving (unlike an arbitrary axis permutation/
    /// mirroring, see `frame::FrameTransform::flips_winding`), and normals
    /// are always recomputed from winding, never stored.
    pub fn rotated_around_x(&self, degrees: f32) -> Mesh {
        let rotation = glam::Quat::from_rotation_x(degrees.to_radians());
        Mesh {
            vertices: self.vertices.iter().map(|&v| rotation * v).collect(),
            triangles: self.triangles.clone(),
        }
    }

    pub fn triangle_positions(&self, tri: [u32; 3]) -> [Vec3; 3] {
        [
            self.vertices[tri[0] as usize],
            self.vertices[tri[1] as usize],
            self.vertices[tri[2] as usize],
        ]
    }

    /// Unit normal via the right-hand rule over vertex winding, ignoring whatever
    /// normal (if any) the source file claimed — STL face normals are frequently
    /// stale or wrong and should never be trusted over the geometry itself.
    pub fn triangle_normal(&self, tri: [u32; 3]) -> Vec3 {
        let [a, b, c] = self.triangle_positions(tri);
        (b - a).cross(c - a).normalize_or_zero()
    }

    pub fn triangle_area(&self, tri: [u32; 3]) -> f32 {
        let [a, b, c] = self.triangle_positions(tri);
        (b - a).cross(c - a).length() * 0.5
    }

    pub fn triangle_centroid(&self, tri: [u32; 3]) -> Vec3 {
        let [a, b, c] = self.triangle_positions(tri);
        (a + b + c) / 3.0
    }

    pub fn bounding_box(&self) -> Aabb {
        let mut aabb = Aabb::empty();
        for v in &self.vertices {
            aabb.expand(*v);
        }
        aabb
    }

    /// Smooth (Gouraud) shading normals: area-weighted average of each vertex's
    /// adjacent face normals. Face normals are recomputed from winding, not read
    /// from the source file — see `triangle_normal`.
    pub fn vertex_normals(&self) -> Vec<Vec3> {
        let mut accum = vec![Vec3::ZERO; self.vertices.len()];
        for &tri in &self.triangles {
            let normal = self.triangle_normal(tri);
            let area = self.triangle_area(tri);
            for idx in tri {
                accum[idx as usize] += normal * area;
            }
        }
        accum.into_iter().map(Vec3::normalize_or_zero).collect()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

impl Aabb {
    pub fn empty() -> Self {
        Self {
            min: Vec3::splat(f32::INFINITY),
            max: Vec3::splat(f32::NEG_INFINITY),
        }
    }

    pub fn expand(&mut self, p: Vec3) {
        self.min = self.min.min(p);
        self.max = self.max.max(p);
    }

    pub fn size(&self) -> Vec3 {
        self.max - self.min
    }

    pub fn center(&self) -> Vec3 {
        (self.min + self.max) * 0.5
    }

    pub fn expanded_by(&self, margin: Vec3) -> Aabb {
        Aabb {
            min: self.min - margin,
            max: self.max + margin,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [3, 6, 2],
            [3, 7, 6],
            [0, 7, 3],
            [0, 4, 7],
            [1, 2, 6],
            [1, 6, 5],
        ];
        Mesh { vertices, triangles }
    }

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
    fn zero_degree_rotation_is_identity() {
        let mesh = unit_cube_mesh();
        let rotated = mesh.rotated_around_x(0.0);
        for (a, b) in mesh.vertices.iter().zip(&rotated.vertices) {
            assert!((*a - *b).length() < 1e-6);
        }
    }

    #[test]
    fn ninety_degrees_maps_y_to_z() {
        let mesh = Mesh { vertices: vec![Vec3::new(0.0, 1.0, 0.0)], triangles: vec![] };
        let rotated = mesh.rotated_around_x(90.0);
        assert!((rotated.vertices[0] - Vec3::new(0.0, 0.0, 1.0)).length() < 1e-5);
    }

    #[test]
    fn rotation_preserves_outward_winding() {
        let mesh = unit_cube_mesh();
        assert!(signed_volume(&mesh) > 0.0, "fixture itself must be outward-oriented");

        for degrees in [15.0, 45.0, 90.0, 180.0, 270.0] {
            let rotated = mesh.rotated_around_x(degrees);
            assert!(
                signed_volume(&rotated) > 0.0,
                "rotation by {degrees} degrees should never flip winding, got signed volume {}",
                signed_volume(&rotated)
            );
        }
    }
}
