use glam::Vec3;
use rayon::prelude::*;

use crate::mesh::{Aabb, Mesh};

#[derive(Debug, Clone)]
pub struct VoxelGrid {
    pub dims: (usize, usize, usize),
    pub domain: Aabb,
    /// Flattened `x + nx * (y + ny * z)`, `true` = SOLID.
    pub solid: Vec<bool>,
}

impl VoxelGrid {
    pub fn index(&self, x: usize, y: usize, z: usize) -> usize {
        x + self.dims.0 * (y + self.dims.1 * z)
    }

    pub fn is_solid(&self, x: usize, y: usize, z: usize) -> bool {
        self.solid[self.index(x, y, z)]
    }

    pub fn occupancy_fraction(&self) -> f32 {
        let solid_count = self.solid.iter().filter(|&&s| s).count();
        solid_count as f32 / self.solid.len() as f32
    }

    pub fn cell_size(&self) -> Vec3 {
        let size = self.domain.size();
        Vec3::new(
            size.x / self.dims.0 as f32,
            size.y / self.dims.1 as f32,
            size.z / self.dims.2 as f32,
        )
    }
}

/// Rasterizes `mesh` into a `dims`-resolution grid over `domain` by casting one
/// ray per (y, z) column along +X and toggling SOLID/FLUID at each triangle
/// crossing (even-odd rule) — this tests each triangle once per column instead
/// of once per cell, which is what makes a brute-force approach tractable.
///
/// This is a ray-parity classifier: it assumes `mesh` is a closed, manifold
/// shell. Small STL leaks (open edges — see `mesh_repair::count_open_edges`)
/// can flip the parity for an entire column and misclassify large regions; a
/// winding-number classifier would be more tolerant of that but isn't
/// implemented here yet — see the plan's voxelizer-robustness risk note.
pub fn voxelize(mesh: &Mesh, domain: Aabb, dims: (usize, usize, usize)) -> VoxelGrid {
    let (nx, ny, nz) = dims;
    let cell = {
        let size = domain.size();
        Vec3::new(size.x / nx as f32, size.y / ny as f32, size.z / nz as f32)
    };

    struct TriProj {
        pos: [Vec3; 3],
        y_range: (f32, f32),
        z_range: (f32, f32),
    }

    let projected: Vec<TriProj> = mesh
        .triangles
        .iter()
        .map(|&tri| {
            let pos = mesh.triangle_positions(tri);
            let ys = [pos[0].y, pos[1].y, pos[2].y];
            let zs = [pos[0].z, pos[1].z, pos[2].z];
            TriProj {
                pos,
                y_range: (ys[0].min(ys[1]).min(ys[2]), ys[0].max(ys[1]).max(ys[2])),
                z_range: (zs[0].min(zs[1]).min(zs[2]), zs[0].max(zs[1]).max(zs[2])),
            }
        })
        .collect();

    let columns: Vec<(usize, usize)> =
        (0..ny).flat_map(|y| (0..nz).map(move |z| (y, z))).collect();

    let column_solid: Vec<Vec<bool>> = columns
        .par_iter()
        .map(|&(yi, zi)| {
            // A small, differently-scaled jitter on each axis so the sample point
            // essentially never lands exactly on a mesh edge — without it, a
            // symmetric/structured mesh can put the sample exactly on a shared
            // edge between two triangles, double-counting (or missing) that
            // crossing and corrupting the parity for the whole column.
            let y = domain.min.y + (yi as f32 + 0.5) * cell.y + cell.y * 1.0e-4;
            let z = domain.min.z + (zi as f32 + 0.5) * cell.z + cell.z * 3.7e-4;

            let mut xs: Vec<f32> = projected
                .iter()
                .filter(|t| y >= t.y_range.0 && y <= t.y_range.1 && z >= t.z_range.0 && z <= t.z_range.1)
                .filter_map(|t| column_hit(t.pos, y, z))
                .collect();
            xs.sort_by(|a, b| a.partial_cmp(b).unwrap());

            let mut col = vec![false; nx];
            let mut crossing = 0;
            let mut inside = false;
            for (xi, cell_solid) in col.iter_mut().enumerate() {
                let x_center = domain.min.x + (xi as f32 + 0.5) * cell.x;
                while crossing < xs.len() && xs[crossing] < x_center {
                    inside = !inside;
                    crossing += 1;
                }
                *cell_solid = inside;
            }
            col
        })
        .collect();

    let mut solid = vec![false; nx * ny * nz];
    for (ci, &(yi, zi)) in columns.iter().enumerate() {
        for xi in 0..nx {
            solid[xi + nx * (yi + ny * zi)] = column_solid[ci][xi];
        }
    }

    VoxelGrid { dims, domain, solid }
}

fn signed_area2(a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> f32 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

/// If the ray through `(y, z)` along +X crosses this triangle, returns the X
/// coordinate of the crossing via barycentric interpolation in the YZ projection.
fn column_hit(tri_pos: [Vec3; 3], y: f32, z: f32) -> Option<f32> {
    let p = (y, z);
    let a = (tri_pos[0].y, tri_pos[0].z);
    let b = (tri_pos[1].y, tri_pos[1].z);
    let c = (tri_pos[2].y, tri_pos[2].z);

    let total = signed_area2(a, b, c);
    if total.abs() < 1e-12 {
        return None; // triangle edge-on to the ray direction: zero-area projection
    }

    const TOL: f32 = -1e-6;
    let wa = signed_area2(p, b, c) / total;
    let wb = signed_area2(p, c, a) / total;
    let wc = signed_area2(p, a, b) / total;
    if wa < TOL || wb < TOL || wc < TOL {
        return None;
    }

    Some(wa * tri_pos[0].x + wb * tri_pos[1].x + wc * tri_pos[2].x)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_cube_mesh() -> Mesh {
        // Closed unit cube [0,1]^3, outward-facing triangles.
        let v = |x: f32, y: f32, z: f32| Vec3::new(x, y, z);
        let vertices = vec![
            v(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0), v(1.0, 1.0, 0.0), v(0.0, 1.0, 0.0),
            v(0.0, 0.0, 1.0), v(1.0, 0.0, 1.0), v(1.0, 1.0, 1.0), v(0.0, 1.0, 1.0),
        ];
        let triangles = vec![
            [0, 2, 1], [0, 3, 2], // -Z face
            [4, 5, 6], [4, 6, 7], // +Z face
            [0, 1, 5], [0, 5, 4], // -Y face
            [3, 6, 2], [3, 7, 6], // +Y face
            [0, 4, 7], [0, 7, 3], // -X face
            [1, 2, 6], [1, 6, 5], // +X face
        ];
        Mesh { vertices, triangles }
    }

    #[test]
    fn classifies_unit_cube_interior_and_exterior() {
        let mesh = unit_cube_mesh();
        let domain = Aabb { min: Vec3::splat(-0.5), max: Vec3::splat(1.5) };
        let grid = voxelize(&mesh, domain, (20, 20, 20));

        // Cell center near (0.5, 0.5, 0.5) should be solid.
        let center_idx = (10usize, 10usize, 10usize);
        assert!(grid.is_solid(center_idx.0, center_idx.1, center_idx.2));

        // Cell near the domain corner (-0.4,-0.4,-0.4) should be fluid.
        assert!(!grid.is_solid(0, 0, 0));

        let occ = grid.occupancy_fraction();
        assert!(occ > 0.05 && occ < 0.3, "occupancy {occ} outside plausible range for a unit cube in a 2^3 domain");
    }
}
