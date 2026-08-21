use std::collections::HashMap;

use glam::Vec3;

use crate::mesh::Mesh;

#[derive(Debug, Default, Clone, Copy)]
pub struct RepairReport {
    pub vertices_welded: usize,
    pub degenerate_removed: usize,
    pub open_edges: usize,
    pub components_flipped: usize,
}

/// Runs the full repair pipeline: epsilon-weld near-duplicate vertices (STL files
/// commonly have per-triangle "shared" corners that differ in the last float bit
/// or two, which stl_io's exact-match dedup won't catch), drop degenerate
/// (near-zero-area) triangles, and make triangle winding consistent within each
/// connected component (flipping the whole component outward if its signed
/// volume comes out negative). Reports an open-edge count as a non-manifold/leak
/// warning signal for the caller to surface — it does not attempt to close holes.
pub fn repair(mesh: &Mesh, weld_epsilon: f32) -> (Mesh, RepairReport) {
    let (welded, vertices_welded) = weld_vertices(mesh, weld_epsilon);
    let (culled, degenerate_removed) = drop_degenerate_triangles(&welded);
    let (oriented, components_flipped) = fix_winding(&culled);
    let open_edges = count_open_edges(&oriented);

    (
        oriented,
        RepairReport {
            vertices_welded,
            degenerate_removed,
            open_edges,
            components_flipped,
        },
    )
}

/// Spatial-hash weld: buckets vertices into an `epsilon`-sized grid and merges any
/// vertex into the first bucket-mate found within `epsilon`, so nearly-coincident
/// corners from independently-triangulated faces become a single shared vertex.
fn weld_vertices(mesh: &Mesh, epsilon: f32) -> (Mesh, usize) {
    if epsilon <= 0.0 {
        return (mesh.clone(), 0);
    }

    let cell = |p: Vec3| -> (i64, i64, i64) {
        (
            (p.x / epsilon).floor() as i64,
            (p.y / epsilon).floor() as i64,
            (p.z / epsilon).floor() as i64,
        )
    };

    let mut buckets: HashMap<(i64, i64, i64), Vec<u32>> = HashMap::new();
    let mut new_vertices: Vec<Vec3> = Vec::new();
    let mut remap: Vec<u32> = Vec::with_capacity(mesh.vertices.len());

    for &v in &mesh.vertices {
        let (cx, cy, cz) = cell(v);
        let mut found = None;
        'neighbors: for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(candidates) = buckets.get(&(cx + dx, cy + dy, cz + dz)) {
                        for &idx in candidates {
                            if new_vertices[idx as usize].distance(v) <= epsilon {
                                found = Some(idx);
                                break 'neighbors;
                            }
                        }
                    }
                }
            }
        }

        let idx = match found {
            Some(idx) => idx,
            None => {
                let idx = new_vertices.len() as u32;
                new_vertices.push(v);
                buckets.entry((cx, cy, cz)).or_default().push(idx);
                idx
            }
        };
        remap.push(idx);
    }

    let welded_count = mesh.vertices.len() - new_vertices.len();
    let triangles = mesh
        .triangles
        .iter()
        .map(|t| [remap[t[0] as usize], remap[t[1] as usize], remap[t[2] as usize]])
        .collect();

    (
        Mesh {
            vertices: new_vertices,
            triangles,
        },
        welded_count,
    )
}

fn drop_degenerate_triangles(mesh: &Mesh) -> (Mesh, usize) {
    const MIN_AREA: f32 = 1e-12;
    let mut kept = Vec::with_capacity(mesh.triangles.len());
    let mut removed = 0;
    for &tri in &mesh.triangles {
        if tri[0] == tri[1] || tri[1] == tri[2] || tri[0] == tri[2] {
            removed += 1;
            continue;
        }
        if mesh.triangle_area(tri) < MIN_AREA {
            removed += 1;
            continue;
        }
        kept.push(tri);
    }
    (
        Mesh {
            vertices: mesh.vertices.clone(),
            triangles: kept,
        },
        removed,
    )
}

/// Walks each connected component (via edge adjacency) and flips any triangle
/// whose winding disagrees with its already-visited neighbors, then flips the
/// whole component if its net signed volume is negative — fixing the common STL
/// bug of a handful of triangles wound backwards, and orienting each shell
/// outward. This does not repair non-manifold topology or true holes.
fn fix_winding(mesh: &Mesh) -> (Mesh, usize) {
    let n = mesh.triangles.len();
    if n == 0 {
        return (mesh.clone(), 0);
    }

    // Undirected edge -> triangles that touch it, each tagged with the local
    // direction that triangle traverses the edge.
    let mut edge_to_tris: HashMap<(u32, u32), Vec<(usize, bool)>> = HashMap::new();
    for (ti, tri) in mesh.triangles.iter().enumerate() {
        for i in 0..3 {
            let a = tri[i];
            let b = tri[(i + 1) % 3];
            let key = (a.min(b), a.max(b));
            let forward = a < b;
            edge_to_tris.entry(key).or_default().push((ti, forward));
        }
    }

    let mut winding = mesh.triangles.clone();
    let mut visited = vec![false; n];
    let mut flip = vec![false; n];
    let mut components_flipped = 0;

    for start in 0..n {
        if visited[start] {
            continue;
        }
        let mut stack = vec![start];
        visited[start] = true;
        let mut component = vec![start];

        while let Some(ti) = stack.pop() {
            let tri = winding[ti];
            for i in 0..3 {
                let a = tri[i];
                let b = tri[(i + 1) % 3];
                let key = (a.min(b), a.max(b));
                let this_forward = a < b;
                if let Some(neighbors) = edge_to_tris.get(&key) {
                    for &(nj, n_forward) in neighbors {
                        if nj == ti || visited[nj] {
                            continue;
                        }
                        // Consistently-oriented adjacent triangles traverse a shared
                        // edge in opposite directions; if they match, nj is backwards.
                        if n_forward == this_forward {
                            flip[nj] = !flip[nj];
                            winding[nj] = [winding[nj][0], winding[nj][2], winding[nj][1]];
                        }
                        visited[nj] = true;
                        component.push(nj);
                        stack.push(nj);
                    }
                }
            }
        }

        // Outward-orientation check via the divergence-theorem signed volume:
        // sum over triangles of centroid . normal * area (unnormalized), which is
        // positive iff the shell's normals point outward for this winding.
        let signed_volume: f32 = component
            .iter()
            .map(|&ti| {
                let tri = winding[ti];
                let [a, b, c] = [
                    mesh.vertices[tri[0] as usize],
                    mesh.vertices[tri[1] as usize],
                    mesh.vertices[tri[2] as usize],
                ];
                a.dot(b.cross(c)) / 6.0
            })
            .sum();

        if signed_volume < 0.0 {
            for &ti in &component {
                winding[ti] = [winding[ti][0], winding[ti][2], winding[ti][1]];
            }
            components_flipped += 1;
        }
    }

    (
        Mesh {
            vertices: mesh.vertices.clone(),
            triangles: winding,
        },
        components_flipped,
    )
}

fn count_open_edges(mesh: &Mesh) -> usize {
    // A closed manifold shell has every directed edge matched by exactly one
    // opposite-direction edge from its neighbor. Whatever never finds its match
    // is a hole/leak boundary.
    let mut unmatched: HashMap<(u32, u32), i32> = HashMap::new();
    for tri in &mesh.triangles {
        for i in 0..3 {
            let a = tri[i];
            let b = tri[(i + 1) % 3];
            if let Some(count) = unmatched.get_mut(&(b, a)) {
                *count -= 1;
                if *count == 0 {
                    unmatched.remove(&(b, a));
                }
            } else {
                *unmatched.entry((a, b)).or_insert(0) += 1;
            }
        }
    }
    unmatched.values().map(|&c| c.unsigned_abs() as usize).sum()
}
