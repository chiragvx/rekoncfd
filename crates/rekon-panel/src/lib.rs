pub mod aero_coeffs;
pub mod aic;
pub mod solve;
pub mod trim;
pub mod wake;

pub use aero_coeffs::{coefficients, solve_and_integrate, surface_flow, Coefficients, SurfaceFlow};
pub use solve::{Freestream, PanelConfig, PanelError, PanelModel, ReferenceQuantities, SolveResult};
pub use trim::{find_trim, polar, static_margin_at, PolarPoint, TrimError, TrimResult};

/// Synthetic test meshes shared across this crate's own unit tests (`solve`,
/// `aero_coeffs`, `trim`). Not part of the public API.
#[cfg(test)]
pub(crate) mod fixtures {
    use glam::Vec3;
    use rekon_geometry::Mesh;

    /// A closed, watertight, symmetric (no camber, no twist) diamond-airfoil
    /// wing: constant chord, rectangular planform, biconvex cross-section
    /// mirror-symmetric about Y=0. By construction CL(alpha=0) should be
    /// exactly 0 (every panel on the top surface has a mirror-image panel on
    /// the bottom with the same |normal.y|), which is exactly what the CL
    /// sanity test wants to check against.
    ///
    /// Triangle winding here is arbitrary (not hand-verified outward) --
    /// callers that need a properly outward-oriented, guaranteed-watertight
    /// mesh should run it through `rekon_geometry::repair` first, which is
    /// independently tested to fix exactly that.
    ///
    /// Moderate chordwise resolution (4 panels per straight LE/TE segment,
    /// see `symmetric_diamond_wing_res`) -- enough that flow-tangency isn't
    /// dominated by sharp-corner discretization error the way a single
    /// panel per segment is (see the depth-convergence check in `solve`'s
    /// tests).
    pub fn symmetric_diamond_wing(span: f32, chord: f32, thickness: f32, n_span: usize) -> Mesh {
        symmetric_diamond_wing_res(span, chord, thickness, n_span, 4)
    }

    /// Same wing as `symmetric_diamond_wing`, with `n_per_side` panels along
    /// each of the 4 straight cross-section segments (LE->top, top->TE,
    /// TE->bottom, bottom->LE) instead of a fixed 1 -- a simple "ring
    /// extrusion" mesh (quad strips between spanwise stations, fan-
    /// triangulated end caps), which is topologically the same shape as the
    /// original 4-point-per-station diamond at n_per_side=1.
    pub fn symmetric_diamond_wing_res(
        span: f32,
        chord: f32,
        thickness: f32,
        n_span: usize,
        n_per_side: usize,
    ) -> Mesh {
        assert!(n_span >= 2 && n_per_side >= 1);
        let half_span = span * 0.5;
        let corners = [
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(chord * 0.5, thickness * 0.5, 0.0),
            Vec3::new(chord, 0.0, 0.0),
            Vec3::new(chord * 0.5, -thickness * 0.5, 0.0),
        ];
        let n_per_ring = 4 * n_per_side;

        let mut vertices = Vec::with_capacity(n_span * n_per_ring);
        for k in 0..n_span {
            let z = -half_span + span * (k as f32) / (n_span as f32 - 1.0);
            for edge in 0..4 {
                let a = corners[edge];
                let b = corners[(edge + 1) % 4];
                for i in 0..n_per_side {
                    let t = i as f32 / n_per_side as f32;
                    let p = a + (b - a) * t;
                    vertices.push(Vec3::new(p.x, p.y, z));
                }
            }
        }
        let ring_index = |k: usize, i: usize| -> u32 { (k * n_per_ring + i % n_per_ring) as u32 };

        let mut triangles = Vec::new();
        for k in 0..n_span - 1 {
            for i in 0..n_per_ring {
                let a = ring_index(k, i);
                let b = ring_index(k, i + 1);
                let c = ring_index(k + 1, i + 1);
                let d = ring_index(k + 1, i);
                triangles.push([a, b, c]);
                triangles.push([a, c, d]);
            }
        }
        // Fan from vertex 0 is degenerate here for n_per_side > 1: several
        // ring points are collinear with vertex 0 along the same straight
        // cross-section edge, producing zero-area triangles that `repair`
        // then drops, leaving the cap non-watertight. Fanning from an
        // inserted interior centroid avoids that (generically not collinear
        // with any boundary edge) and still triangulates the whole ring.
        for &k in &[0, n_span - 1] {
            let z = vertices[ring_index(k, 0) as usize].z;
            let centroid_idx = vertices.len() as u32;
            vertices.push(Vec3::new(chord * 0.5, 0.0, z));
            for i in 0..n_per_ring {
                triangles.push([centroid_idx, ring_index(k, i), ring_index(k, i + 1)]);
            }
        }

        Mesh { vertices, triangles }
    }

    /// A closed, watertight, symmetric wing with a smooth (rounded) leading
    /// edge and a sharp (cusped) trailing edge -- unlike
    /// `symmetric_diamond_wing`'s mathematically sharp, zero-radius leading
    /// edge, which is a genuine potential-flow singularity (infinite
    /// tangential velocity right at the tip in idealized inviscid theory,
    /// same reason a real airfoil is never pointed at the nose) that no
    /// amount of panel refinement resolves and that concentrated a large,
    /// non-shrinking flow-tangency residual on exactly the LE-adjacent
    /// panels. Thickness distribution t(x) = sqrt(x/c)*(1-x/c), normalized to
    /// peak at `thickness` -- sqrt(x/c) gives the LE infinite slope (rounded
    /// nose) while the linear (1-x/c) factor gives the TE a finite slope
    /// (proper sharp cusp for the Kutta condition to act on).
    pub fn smooth_symmetric_wing(span: f32, chord: f32, thickness: f32, n_span: usize, n_chord: usize) -> Mesh {
        assert!(n_span >= 2 && n_chord >= 3);
        let half_span = span * 0.5;

        // Cosine clustering puts more stations near both LE and TE, where the
        // surface curvature/gradient is largest.
        let x_at = |i: usize| -> f32 {
            let s = i as f32 / (n_chord - 1) as f32;
            chord * 0.5 * (1.0 - (s * std::f32::consts::PI).cos())
        };
        let peak = (1.0f32 / 3.0).sqrt() * (2.0 / 3.0); // max of sqrt(s)(1-s) on [0,1], at s=1/3
        let half_thickness_at = |x: f32| -> f32 {
            let s = (x / chord).clamp(0.0, 1.0);
            thickness * 0.5 * (s.sqrt() * (1.0 - s)) / peak
        };

        let n_per_ring = 2 * (n_chord - 1);
        let mut vertices = Vec::with_capacity(n_span * n_per_ring);
        for k in 0..n_span {
            let z = -half_span + span * (k as f32) / (n_span as f32 - 1.0);
            for i in 0..n_chord {
                let x = x_at(i);
                vertices.push(Vec3::new(x, half_thickness_at(x), z));
            }
            for i in (1..n_chord - 1).rev() {
                let x = x_at(i);
                vertices.push(Vec3::new(x, -half_thickness_at(x), z));
            }
        }
        let ring_index = |k: usize, i: usize| -> u32 { (k * n_per_ring + i % n_per_ring) as u32 };

        let mut triangles = Vec::new();
        for k in 0..n_span - 1 {
            for i in 0..n_per_ring {
                let a = ring_index(k, i);
                let b = ring_index(k, i + 1);
                let c = ring_index(k + 1, i + 1);
                let d = ring_index(k + 1, i);
                triangles.push([a, b, c]);
                triangles.push([a, c, d]);
            }
        }
        for &k in &[0, n_span - 1] {
            let z = vertices[ring_index(k, 0) as usize].z;
            let centroid_idx = vertices.len() as u32;
            vertices.push(Vec3::new(chord * 0.5, 0.0, z));
            for i in 0..n_per_ring {
                triangles.push([centroid_idx, ring_index(k, i), ring_index(k, i + 1)]);
            }
        }

        Mesh { vertices, triangles }
    }

    /// A UV-sphere: smooth, convex, no sharp features anywhere. Used to
    /// isolate whether a flow-tangency failure is a fundamental solver bug
    /// (a sphere would fail too) versus something specific to sharp/thin
    /// wing-like geometry (a sphere passes cleanly).
    pub fn uv_sphere(radius: f32, n_lat: usize, n_lon: usize) -> Mesh {
        assert!(n_lat >= 2 && n_lon >= 3);
        let mut vertices = Vec::new();
        for i in 0..=n_lat {
            let theta = std::f32::consts::PI * i as f32 / n_lat as f32; // 0..pi
            for j in 0..n_lon {
                let phi = 2.0 * std::f32::consts::PI * j as f32 / n_lon as f32;
                vertices.push(Vec3::new(
                    radius * theta.sin() * phi.cos(),
                    radius * theta.cos(),
                    radius * theta.sin() * phi.sin(),
                ));
            }
        }
        let idx = |i: usize, j: usize| -> u32 { (i * n_lon + j % n_lon) as u32 };
        let mut triangles = Vec::new();
        for i in 0..n_lat {
            for j in 0..n_lon {
                let a = idx(i, j);
                let b = idx(i, j + 1);
                let c = idx(i + 1, j + 1);
                let d = idx(i + 1, j);
                if i != 0 {
                    triangles.push([a, b, c]);
                }
                if i != n_lat - 1 {
                    triangles.push([a, c, d]);
                }
            }
        }
        Mesh { vertices, triangles }
    }
}
