use glam::Vec3;

/// Indexed triangle mesh shared by the STL import, repair, panelizer, and voxelizer stages.
#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub vertices: Vec<Vec3>,
    /// Each triangle is three indices into `vertices`.
    pub triangles: Vec<[u32; 3]>,
}

impl Mesh {
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
