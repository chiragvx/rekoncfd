//! Trailing-edge wake model: one thin quad doublet panel per spanwise TE
//! station, running from the trailing edge downstream to a large-but-finite
//! distance (a standard, practical stand-in for the analytically semi-
//! infinite wake used by e.g. VSAERO/PANAIR -- see the module-level caveat in
//! `lib.rs`). Each wake panel's doublet strength is pinned, via the implicit
//! Kutta condition, to `mu_upper_te - mu_lower_te` of the two body panels
//! that meet at that station, which is why `fold_wake_into_c` adds its
//! influence directly into the body doublet-AIC columns for those two panels
//! rather than the wake ever being its own solve unknown.

use nalgebra::{DMatrix, Vector3};
use rayon::prelude::*;
use rekon_geometry::{Panel, TeStrip};

use crate::aic::{doublet_potential, doublet_velocity, PanelGeom};

/// One spanwise wake station: a quad panel (split into two triangles for the
/// doublet kernels, which only know how to evaluate triangles) whose doublet
/// strength equals `mu[upper_panel] - mu[lower_panel]` once a mesh is solved.
#[derive(Debug, Clone)]
pub struct WakePanel {
    pub upper_panel: usize,
    pub lower_panel: usize,
    pub z_center: f64,
    tri_a: PanelGeom,
    tri_b: PanelGeom,
}

impl WakePanel {
    pub fn doublet_potential_at(&self, field_point: Vector3<f64>) -> f64 {
        doublet_potential(&self.tri_a, field_point) + doublet_potential(&self.tri_b, field_point)
    }

    pub fn doublet_velocity_at(&self, field_point: Vector3<f64>, core_radius: f64) -> Vector3<f64> {
        doublet_velocity(&self.tri_a, field_point, core_radius) + doublet_velocity(&self.tri_b, field_point, core_radius)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct WakeConfig {
    /// How far downstream (+X, meters) the wake panels extend. A true
    /// semi-infinite analytic wake panel would remove this parameter
    /// entirely; a large finite length is the standard practical
    /// approximation (see module docs) -- `solve::PanelConfig`'s default
    /// factor is 25x the mesh span, generous enough that doubling it moves
    /// near-body results by well under numerical-test tolerance for the
    /// meshes this crate is validated against.
    pub wake_length_m: f64,
    pub core_radius_m: f64,
    /// Small aft (+X) nudge applied to the wake sheet's near (TE-attached)
    /// edge, as insurance against curved-TE sagitta and mesh-weld noise
    /// putting the "planar ruled sheet through the exact TE vertices"
    /// construction (see `build_wake`) a hair's-width forward of the real
    /// skin. Set by `solve::PanelModel::build` to `1e-3 * mean_panel_scale`.
    pub te_aft_nudge_m: f64,
}

/// Builds one wake panel per TE station as a TE-CONFORMING RULED SHEET: the
/// near (upstream) edge of every wake quad tracks the actual local trailing
/// edge, rather than sitting at one constant `x` for the whole strip.
///
/// # Why this matters (root-caused, not a guess)
///
/// An earlier version built each strip's wake quad as an axis-aligned
/// rectangle at a single `x = te.x` (that strip's own most-aft vertex),
/// spanning `te.z +/- half_width`. That is exactly right for a
/// constant-chord wing (every station's TE really does sit at the same x),
/// but on a TAPERED or SWEPT trailing edge the true TE moves in x as z moves
/// within the strip's spanwise band, so the flat rectangle strays off the
/// real TE line and slices INTO the wing's own skin. Measured on a
/// representative tapered fixture: penetration up to 4.25mm against a local
/// skin half-thickness of only ~0.6mm. Collocation points sit a few
/// micrometers inside that skin, so a wake sheet passing through it puts
/// collocation points on both sides of the doublet sheet's own jump
/// discontinuity -- `fold_wake_into_c` then injects correction terms
/// approaching the full +/-1/2 doublet jump (the same magnitude as the AIC
/// matrix's own diagonal) into the C matrix, with opposite sign on the upper
/// vs. lower row of each station. That is large enough to invert the
/// resolved circulation distribution, which is what previously flipped the
/// sign of dCL/dalpha for any tapered/swept mesh (straight-TE wings have
/// zero penetration, hence were never affected).
///
/// The fix: treat every TE-strip's own `trailing_edge` VERTEX (not the
/// bin's `z_center`, which is a synthetic bin midpoint the real TE need not
/// pass through) as a node on a TE polyline, sorted ascending by z. Station
/// k's quad spans z from the midpoint of nodes k-1 and k to the midpoint of
/// nodes k and k+1 (clamped to the two extreme TE vertices at the ends, so
/// there is no extrapolation past real geometry), with the quad's near edge
/// LINEARLY INTERPOLATED (in x and y) between the bracketing TE nodes at
/// those z values. Adjacent quads share their boundary edge exactly, so the
/// sheet has no spanwise gaps or overlaps. A quad built this way -- corners
/// `near_a`, `near_b`, and both `+ (wake_length, 0, 0)` -- is provably planar
/// (it's two points swept along one shared vector), so the existing
/// two-triangle split and `+Y`-normal convention still apply unchanged.
///
/// Kutta pairing (nearest body panel to each strip's own TE point, upper vs.
/// lower via `normal.y`, excluding near-spanwise cap panels) is unchanged --
/// it was independently correct and is not the source of the bug above.
pub fn build_wake(panels: &[Panel], te_strips: &[TeStrip], n_strips: usize, config: WakeConfig) -> Vec<WakePanel> {
    if te_strips.is_empty() || panels.is_empty() {
        return Vec::new();
    }

    let z_min = panels.iter().map(|p| p.centroid.z).fold(f32::INFINITY, f32::min);
    let z_max = panels.iter().map(|p| p.centroid.z).fold(f32::NEG_INFINITY, f32::max);
    let z_span = (z_max - z_min).max(f32::EPSILON);
    let half_width = (z_span / n_strips as f32) * 0.5;

    // Finds the body panel genuinely adjacent to this strip's own TE point,
    // separately on the upper (normal.y > 0) and lower (normal.y <= 0)
    // side, searching a band around the strip's bin center. Independent of
    // the wake sheet's own geometry below -- this is the Kutta-pairing
    // logic only.
    //
    // Ranks candidates first by "touch" distance -- from `te` to the
    // panel's OWN nearest vertex -- falling back to centroid distance only
    // as a tie-break. `te` is itself an actual mesh vertex (see
    // `detect_trailing_edge_strips`), so a genuinely TE-adjacent panel has
    // touch ~0. Ranking on centroid distance ALONE (an earlier version of
    // this search) has a real failure mode on tapered/swept meshes: as
    // panels shrink toward a tapered tip, a panel one quad-strip further
    // from the TE can have a smaller raw centroid distance than the
    // genuinely adjacent one (especially since this mesh's per-quad
    // diagonal-split convention isn't mirror-consistent between the upper
    // and lower vertex-ring traversals, so "nearest centroid" independently
    // computed for each side isn't guaranteed to land on matching panels) --
    // silently attaching the Kutta condition to the wrong panel, confirmed
    // to inject an error large enough to invert a tapered wing's CL(alpha=0)
    // symmetry via `fold_wake_into_c`.
    let pair = |strip: &TeStrip| -> Option<(usize, usize)> {
        let z_lo = strip.z_center - half_width * 1.5;
        let z_hi = strip.z_center + half_width * 1.5;
        let te = strip.trailing_edge;

        let mut upper: Option<(usize, f32, f32)> = None; // (idx, touch_dist_sq, centroid_dist_sq)
        let mut lower: Option<(usize, f32, f32)> = None;
        for (idx, p) in panels.iter().enumerate() {
            if p.centroid.z < z_lo || p.centroid.z > z_hi {
                continue;
            }
            // A near-spanwise-facing panel (|normal.y| small) is a wingtip
            // end cap or a near-vertical LE/TE skin sliver, not a genuine
            // upper/lower surface panel -- excluded regardless of which side
            // of zero its normal.y falls on (see git history for the
            // tip-strip case this was originally found on).
            if p.normal.y.abs() < 0.3 {
                continue;
            }
            let touch = p
                .vertices
                .iter()
                .map(|&v| (v - te).length_squared())
                .fold(f32::INFINITY, f32::min);
            let centroid_d = (p.centroid - te).length_squared();
            let key = (touch, centroid_d);
            if p.normal.y > 0.0 {
                if upper.is_none_or(|(_, t, c)| key < (t, c)) {
                    upper = Some((idx, touch, centroid_d));
                }
            } else if lower.is_none_or(|(_, t, c)| key < (t, c)) {
                lower = Some((idx, touch, centroid_d));
            }
        }
        Some((upper?.0, lower?.0))
    };

    // TE polyline: the strips' own TE vertices, sorted ascending by z
    // (defensive -- callers already hand these in z-order today, but nothing
    // enforces it) with near-duplicate-z nodes dropped (a ~zero-width
    // segment would make its ruled quad degenerate).
    let mut nodes: Vec<&TeStrip> = te_strips.iter().collect();
    nodes.sort_by(|a, b| a.trailing_edge.z.partial_cmp(&b.trailing_edge.z).unwrap());
    let eps = z_span * 1e-4;
    nodes.dedup_by(|a, b| (a.trailing_edge.z - b.trailing_edge.z).abs() < eps);

    let aft_nudge = config.te_aft_nudge_m as f32;
    let make_wake_panel = |upper_idx: usize, lower_idx: usize, near_a: Vector3<f64>, near_b: Vector3<f64>| -> WakePanel {
        let far_a = near_a + Vector3::new(config.wake_length_m, 0.0, 0.0);
        let far_b = near_b + Vector3::new(config.wake_length_m, 0.0, 0.0);

        // Quad [near_a, near_b, far_b, far_a] split along the near_a-far_b
        // diagonal; winding chosen so the doublet normal points +Y, matching
        // the sign convention `upper`/`lower` were classified by above
        // (normal.y > 0 = upper). This matters: the wake's contribution
        // below is folded into C with a +1 coefficient on the upper column
        // and -1 on lower, which is only the correct Kutta condition if the
        // wake panel's own normal (defining what "positive mu_wake" means
        // for `doublet_potential`) is oriented the same way as the upper
        // panel's. Winding is consistent between the two triangles so the
        // shared diagonal's vortex-ring contributions cancel in
        // `doublet_velocity_at`.
        let tri_a = PanelGeom::from_vertices(near_a, near_b, far_b);
        let tri_b = PanelGeom::from_vertices(near_a, far_b, far_a);
        debug_assert!(tri_a.normal.y > 0.0 && tri_b.normal.y > 0.0, "wake panel must face +Y");

        WakePanel {
            upper_panel: upper_idx,
            lower_panel: lower_idx,
            z_center: (near_a.z + near_b.z) * 0.5,
            tri_a,
            tri_b,
        }
    };

    if nodes.len() < 2 {
        // Single station (or every station collapsed to ~one z): no
        // polyline to rule a sheet along -- fall back to the old
        // axis-aligned rectangle spanning the requested half-width around
        // that one TE point.
        return nodes
            .first()
            .and_then(|&strip| {
                let (upper_idx, lower_idx) = pair(strip)?;
                let te = strip.trailing_edge;
                let near_a = Vector3::new(te.x as f64, te.y as f64, (te.z - half_width) as f64);
                let near_b = Vector3::new(te.x as f64, te.y as f64, (te.z + half_width) as f64);
                Some(make_wake_panel(upper_idx, lower_idx, near_a, near_b))
            })
            .into_iter()
            .collect();
    }

    // Boundaries[0..=nodes.len()]: boundaries[0] and boundaries[m] are the
    // two extreme TE vertices themselves (no extrapolation past real
    // geometry); boundaries[1..m-1] are the z-midpoint of each adjacent node
    // pair, with x/y linearly interpolated to match (exact for a straight
    // local TE, a controlled approximation for a curved one). Station k's
    // quad spans boundaries[k] to boundaries[k+1] -- adjacent quads share
    // that edge exactly, so the sheet has no gaps or overlaps across the
    // span, computed once here from the FULL node list so that a later
    // dropped pairing (see below) leaves a hole rather than widening its
    // neighbors.
    let m = nodes.len();
    let mut boundaries: Vec<glam::Vec3> = Vec::with_capacity(m + 1);
    boundaries.push(nodes[0].trailing_edge);
    for w in nodes.windows(2) {
        boundaries.push((w[0].trailing_edge + w[1].trailing_edge) * 0.5);
    }
    boundaries.push(nodes[m - 1].trailing_edge);

    (0..m)
        .filter_map(|k| {
            let (upper_idx, lower_idx) = pair(nodes[k])?;
            let lo = boundaries[k];
            let hi = boundaries[k + 1];
            // Near-edge endpoints, nudged aft (+X) by a small fraction of a
            // panel width -- see `WakeConfig::te_aft_nudge_m` doc comment.
            let near_a = Vector3::new((lo.x + aft_nudge) as f64, lo.y as f64, lo.z as f64);
            let near_b = Vector3::new((hi.x + aft_nudge) as f64, hi.y as f64, hi.z as f64);
            Some(make_wake_panel(upper_idx, lower_idx, near_a, near_b))
        })
        .collect()
}

/// Adds each wake panel's doublet-potential influence into the body doublet
/// AIC `c`, in place: column `upper_panel` gets +1 * (wake potential) and
/// column `lower_panel` gets -1 * (wake potential), since `mu_wake =
/// mu_upper - mu_lower` is linear in those two already-existing unknowns --
/// this is the "implicit Kutta condition" the module doc refers to, and it's
/// why solving `C.mu = -B.sigma` with this folded-in `c` needs no separate
/// wake unknowns or extra equations.
pub fn fold_wake_into_c(c: &mut DMatrix<f64>, wake_panels: &[WakePanel], collocation: &[Vector3<f64>]) {
    let n = collocation.len();
    let corrections: Vec<Vec<(usize, f64)>> = collocation
        .par_iter()
        .map(|&p| {
            wake_panels
                .iter()
                .flat_map(|w| {
                    let phi = w.doublet_potential_at(p);
                    [(w.upper_panel, phi), (w.lower_panel, -phi)]
                })
                .collect()
        })
        .collect();

    for i in 0..n {
        for &(j, delta) in &corrections[i] {
            c[(i, j)] += delta;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    fn flat_plate_upper_lower(n_strips: usize) -> (Vec<Panel>, Vec<TeStrip>) {
        // A thin rectangular plate, span 1m (Z), chord 0.2m (X), thickness
        // 0.01m (Y): upper skin at y=+0.005, lower skin at y=-0.005, each
        // split into 2 triangles per spanwise strip so both TE detection and
        // wake-pairing have real per-strip resolution to work with.
        let mut panels = Vec::new();
        let n = 8usize;
        for i in 0..n {
            let z0 = -0.5 + i as f32 / n as f32;
            let z1 = -0.5 + (i + 1) as f32 / n as f32;
            for (y, normal_sign) in [(0.005f32, 1.0f32), (-0.005f32, -1.0f32)] {
                let a = Vec3::new(0.0, y, z0);
                let b = Vec3::new(0.2, y, z0);
                let c = Vec3::new(0.2, y, z1);
                let d = Vec3::new(0.0, y, z1);
                for tri in [[a, b, c], [a, c, d]] {
                    let mut verts = tri;
                    let normal = (verts[1] - verts[0]).cross(verts[2] - verts[0]);
                    if normal.y.signum() != normal_sign.signum() {
                        verts.swap(1, 2);
                    }
                    let area = (verts[1] - verts[0]).cross(verts[2] - verts[0]).length() * 0.5;
                    let normal = (verts[1] - verts[0]).cross(verts[2] - verts[0]).normalize();
                    let centroid = (verts[0] + verts[1] + verts[2]) / 3.0;
                    panels.push(Panel { vertices: verts, centroid, normal, area });
                }
            }
        }

        let strips: Vec<TeStrip> = (0..n_strips)
            .map(|i| {
                let z_center = -0.5 + (i as f32 + 0.5) / n_strips as f32;
                TeStrip {
                    z_center,
                    leading_edge: Vec3::new(0.0, 0.0, z_center),
                    trailing_edge: Vec3::new(0.2, 0.0, z_center),
                }
            })
            .collect();

        (panels, strips)
    }

    /// Same flat-plate skin as `flat_plate_upper_lower`, but each TE
    /// station's `trailing_edge` point tapers chord linearly from 0.2m at
    /// the root (z=-0.5) to 0.05m at the tip (z=+0.5) -- so the true TE
    /// line is NOT a constant x, exercising the ruled-sheet construction
    /// this module's `build_wake` rewrite exists for.
    fn tapered_te_strips(n_strips: usize) -> Vec<TeStrip> {
        (0..n_strips)
            .map(|i| {
                let z_center = -0.5 + (i as f32 + 0.5) / n_strips as f32;
                let t = (z_center + 0.5).clamp(0.0, 1.0); // 0 at root, 1 at tip
                let chord = 0.2 - 0.15 * t;
                TeStrip {
                    z_center,
                    leading_edge: Vec3::new(0.0, 0.0, z_center),
                    trailing_edge: Vec3::new(chord, 0.0, z_center),
                }
            })
            .collect()
    }

    fn default_wake_config() -> WakeConfig {
        WakeConfig { wake_length_m: 5.0, core_radius_m: 1e-6, te_aft_nudge_m: 1e-4 }
    }

    #[test]
    fn pairs_every_strip_with_an_upper_and_lower_te_panel() {
        let (panels, strips) = flat_plate_upper_lower(8);
        let wake = build_wake(&panels, &strips, 8, default_wake_config());
        assert_eq!(wake.len(), strips.len(), "every strip should find both an upper and lower TE panel");
        for w in &wake {
            assert!(panels[w.upper_panel].normal.y > 0.0);
            assert!(panels[w.lower_panel].normal.y <= 0.0);
        }
    }

    /// The two triangles making up one wake quad should behave as a single
    /// consistent panel: their potentials and vortex-ring velocities add
    /// (shared-diagonal contributions cancel), so evaluating "the wake panel"
    /// via either representation at an off-panel point should agree with a
    /// finite-difference check the same way a single triangle does.
    #[test]
    fn wake_panel_velocity_matches_finite_difference_of_its_potential() {
        let (panels, strips) = flat_plate_upper_lower(8);
        let wake = build_wake(&panels, &strips, 8, default_wake_config());
        let w = &wake[4];
        let p = Vector3::new(1.0, 0.2, w.z_center + 0.03);
        let h = 1e-5;
        let ex = Vector3::x();
        let ey = Vector3::y();
        let ez = Vector3::z();
        let grad = Vector3::new(
            (w.doublet_potential_at(p + ex * h) - w.doublet_potential_at(p - ex * h)) / (2.0 * h),
            (w.doublet_potential_at(p + ey * h) - w.doublet_potential_at(p - ey * h)) / (2.0 * h),
            (w.doublet_potential_at(p + ez * h) - w.doublet_potential_at(p - ez * h)) / (2.0 * h),
        );
        let analytic = w.doublet_velocity_at(p, 1e-9);
        assert!((grad - analytic).norm() < 1e-3, "grad={grad:?} analytic={analytic:?}");
    }

    /// Core geometric claim of the ruled-sheet rewrite: adjacent wake quads
    /// on a tapered TE share their boundary edge exactly (no gap, no
    /// overlap), unlike the old constant-x rectangles. `tri_a`/`tri_b` are
    /// private fields, directly accessible here since `tests` is a
    /// descendant module of `wake` -- `tri_a.v[0]`/`v[1]` are exactly
    /// `near_a`/`near_b` per `make_wake_panel`'s construction order.
    #[test]
    fn adjacent_wake_quads_share_edges_exactly_on_a_tapered_te() {
        let (panels, _) = flat_plate_upper_lower(8);
        let strips = tapered_te_strips(8);
        let wake = build_wake(&panels, &strips, 8, default_wake_config());
        assert_eq!(wake.len(), strips.len());

        for pair in wake.windows(2) {
            let this_near_b = pair[0].tri_a.v[1];
            let next_near_a = pair[1].tri_a.v[0];
            assert!(
                (this_near_b - next_near_a).norm() < 1e-9,
                "adjacent quads should share their boundary edge exactly: {this_near_b:?} vs {next_near_a:?}"
            );
        }
    }

    /// The ruled sheet's near edge must sit at (or a tiny aft nudge past)
    /// the local trailing edge it's supposed to hug, never noticeably
    /// forward (upstream, -X) or aft of it -- the failure mode this rewrite
    /// fixes was the OLD constant-x rectangle straying far enough from the
    /// true local TE to slice into the wing's own skin.
    #[test]
    fn wake_near_edge_tracks_the_local_trailing_edge_x() {
        let (panels, _) = flat_plate_upper_lower(8);
        let strips = tapered_te_strips(8);
        let config = default_wake_config();
        let wake = build_wake(&panels, &strips, 8, config);
        assert_eq!(wake.len(), strips.len());

        // tapered_te_strips: chord = 0.2 - 0.15 * t, t = z + 0.5 in [0,1].
        let expected_x_at = |z: f64| -> f64 {
            let t = (z + 0.5).clamp(0.0, 1.0);
            0.2 - 0.15 * t
        };
        for w in &wake {
            for near in [w.tri_a.v[0], w.tri_a.v[1]] {
                let expected = expected_x_at(near.z);
                let delta = near.x - expected;
                assert!(
                    (-1e-5..=config.te_aft_nudge_m + 1e-5).contains(&delta),
                    "wake near-edge x={} at z={} should sit within [0, nudge] of the local TE x={expected}, got delta={delta}",
                    near.x,
                    near.z
                );
            }
        }
    }

    /// `+Y`-normal convention holds for the general (non-flat, z-varying y)
    /// ruled sheet too, not just the old axis-aligned rectangle -- see
    /// `build_wake`'s doc comment for why this is provably always true
    /// (normal.y is proportional to `dz * wake_length`, independent of any
    /// y-variation along the TE).
    #[test]
    fn ruled_sheet_quads_always_face_plus_y() {
        let (panels, _) = flat_plate_upper_lower(8);
        let strips = tapered_te_strips(8);
        let wake = build_wake(&panels, &strips, 8, default_wake_config());
        assert!(!wake.is_empty());
        for w in &wake {
            assert!(w.tri_a.normal.y > 0.0);
            assert!(w.tri_b.normal.y > 0.0);
        }
    }

    /// A single TE station (nothing to rule a sheet along) should fall back
    /// to the old axis-aligned half-width rectangle rather than panicking or
    /// producing a degenerate zero-area quad.
    #[test]
    fn single_strip_falls_back_to_axis_aligned_rectangle() {
        let (panels, strips) = flat_plate_upper_lower(8);
        let one_strip = vec![strips[4]];
        let wake = build_wake(&panels, &one_strip, 8, default_wake_config());
        assert_eq!(wake.len(), 1);
        let w = &wake[0];
        assert!((w.tri_a.v[0].z - w.tri_a.v[1].z).abs() > 1e-6, "rectangle should span nonzero z-width");
        assert!(w.tri_a.normal.y > 0.0 && w.tri_b.normal.y > 0.0);
    }
}
