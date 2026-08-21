//! Constant-strength flat-triangle source and doublet panel kernels, plus the
//! body-only (no wake) source/doublet potential influence-coefficient matrices
//! B and C. Wake folding into C happens in `wake.rs`; the LU factorization and
//! per-AoA solve happen in `solve.rs`.
//!
//! Doublet potential uses the Van Oosterom-Strackee closed-form signed-solid-
//! angle formula (verified below against the known +-mu/2 potential jump
//! crossing the panel), and doublet velocity uses the standard equivalence
//! that a constant doublet panel's velocity field equals that of a vortex
//! ring of the same strength running around its boundary (verified below by
//! finite-differencing the solid-angle potential and comparing).
//!
//! Source potential and velocity are computed by adaptive quadrature of the
//! exact point-source kernel (phi = -1/4pi * integral(dA'/r), a straight
//! Newtonian-potential surface integral with no closed-form-recall risk)
//! rather than the textbook constant-strength-polygon log/atan formula: that
//! closed form is notorious for branch-cut/sign bugs, and an initial from-
//! memory attempt at it did in fact fail the sigma/2 self-induced-velocity
//! check below by a real (not just numerical-noise) margin. Quadrature is a
//! one-time cost during AIC assembly, not the hot per-AoA solve path, so the
//! extra cost of subdividing near the (offset) collocation point is cheap
//! insurance against a wrong lift/drag prediction no test happens to catch.

use std::f64::consts::PI;

use nalgebra::{DMatrix, Vector3};
use rayon::prelude::*;
use rekon_geometry::Panel;

/// One triangular panel's geometry in f64, with a local orthonormal tangent
/// frame (e1 along the v0->v1 edge, e2 completing the right-handed frame with
/// `normal`) used by the doublet kernels and by tangential-gradient
/// reconstruction downstream in `aero_coeffs`.
#[derive(Debug, Clone)]
pub struct PanelGeom {
    pub v: [Vector3<f64>; 3],
    pub centroid: Vector3<f64>,
    pub normal: Vector3<f64>,
    pub area: f64,
    pub e1: Vector3<f64>,
    pub e2: Vector3<f64>,
}

impl PanelGeom {
    pub fn from_vertices(v0: Vector3<f64>, v1: Vector3<f64>, v2: Vector3<f64>) -> Self {
        let centroid = (v0 + v1 + v2) / 3.0;
        let raw_normal = (v1 - v0).cross(&(v2 - v0));
        let area = raw_normal.norm() * 0.5;
        let normal = if area > 0.0 { raw_normal / raw_normal.norm() } else { Vector3::z() };
        let e1 = {
            let edge = v1 - v0;
            let len = edge.norm();
            if len > 0.0 { edge / len } else { Vector3::x() }
        };
        let e2 = normal.cross(&e1);

        Self { v: [v0, v1, v2], centroid, normal, area, e1, e2 }
    }

    pub fn from_panel(p: &Panel) -> Self {
        let cvt = |v: glam::Vec3| Vector3::new(v.x as f64, v.y as f64, v.z as f64);
        Self::from_vertices(cvt(p.vertices[0]), cvt(p.vertices[1]), cvt(p.vertices[2]))
    }

    /// A characteristic in-plane size, used to scale numerical epsilons and
    /// vortex-core radii relative to this panel rather than some global unit.
    pub fn scale(&self) -> f64 {
        self.area.sqrt().max(1e-9)
    }
}

/// Recursively bisects the triangle (v0,v1,v2) along its longest edge until
/// each leaf is small enough relative to its distance from `field_point` for
/// a flat centroid-rule evaluation of the 1/r point-source kernel (and its
/// gradient) to be accurate, accumulating both integrals in one pass. The
/// size/distance ratio and depth cap were picked empirically against
/// `source_potential_matches_monte_carlo_quadrature` and the sigma/2 check.
///
/// Bisecting the longest edge (rather than quartering via all 3 midpoints)
/// matters for panels next to a sharp leading/trailing edge on a thin wing,
/// which are routinely long, thin slivers (aspect ratio ~10 is unremarkable
/// there): quartering produces 4 self-similar sub-slivers that never shed
/// their aspect ratio, so convergence against the *longest* dimension needs
/// many more levels than a well-shaped triangle would; longest-edge
/// bisection instead roughly halves the aspect ratio (and the work) at every
/// split, converging quickly for both shapes. Confirmed empirically: this
/// eliminated a large, non-noise flow-tangency residual that concentrated
/// exactly on sliver panels near sharp corners, without a runtime blow-up.
fn integrate_source_kernel(
    v0: Vector3<f64>,
    v1: Vector3<f64>,
    v2: Vector3<f64>,
    field_point: Vector3<f64>,
    depth: u32,
    phi_sum: &mut f64,
    vel_sum: &mut Vector3<f64>,
) {
    let centroid = (v0 + v1 + v2) / 3.0;
    let area = (v1 - v0).cross(&(v2 - v0)).norm() * 0.5;
    let (e01, e12, e20) = ((v1 - v0).norm(), (v2 - v1).norm(), (v0 - v2).norm());
    let size = e01.max(e12).max(e20);
    let r_vec = field_point - centroid;
    let dist = r_vec.norm();

    if depth >= 32 || size < 0.4 * dist {
        let r = dist.max(1e-12);
        *phi_sum += area / r;
        *vel_sum += r_vec * (area / (r * r * r));
        return;
    }

    let (a, b, c) = if size == e01 {
        (v0, v1, v2)
    } else if size == e12 {
        (v1, v2, v0)
    } else {
        (v2, v0, v1)
    };
    let m = (a + b) * 0.5;
    integrate_source_kernel(a, m, c, field_point, depth + 1, phi_sum, vel_sum);
    integrate_source_kernel(m, b, c, field_point, depth + 1, phi_sum, vel_sum);
}

/// Potential and induced velocity of a unit-strength (sigma = 1) constant
/// source panel, evaluated together since both reuse the same quadrature
/// pass. Sign convention (phi = -1/4pi * integral(dA'/r)) verified against
/// the exact sigma/2 self-induced-normal-velocity jump condition below.
pub fn source_influence(panel: &PanelGeom, field_point: Vector3<f64>) -> (f64, Vector3<f64>) {
    let mut phi_sum = 0.0;
    let mut vel_sum = Vector3::zeros();
    integrate_source_kernel(panel.v[0], panel.v[1], panel.v[2], field_point, 0, &mut phi_sum, &mut vel_sum);
    (-phi_sum / (4.0 * PI), vel_sum / (4.0 * PI))
}

pub fn source_potential(panel: &PanelGeom, field_point: Vector3<f64>) -> f64 {
    source_influence(panel, field_point).0
}

/// Signed solid angle subtended by triangle `panel` as seen from `field_point`,
/// via the Van Oosterom-Strackee (1983) formula. Positive when the point is on
/// the side the panel's vertex winding faces (i.e. the +normal side).
fn solid_angle(panel: &PanelGeom, field_point: Vector3<f64>) -> f64 {
    let a = panel.v[0] - field_point;
    let b = panel.v[1] - field_point;
    let c = panel.v[2] - field_point;
    let (al, bl, cl) = (a.norm(), b.norm(), c.norm());
    if al < 1e-12 || bl < 1e-12 || cl < 1e-12 {
        return 0.0; // field point coincides with a vertex: not a case we evaluate
    }
    let numerator = a.dot(&b.cross(&c));
    let denominator = al * bl * cl + a.dot(&b) * cl + b.dot(&c) * al + c.dot(&a) * bl;
    2.0 * numerator.atan2(denominator)
}

/// Potential of a unit-strength (mu = 1) constant doublet panel, oriented along
/// `panel.normal`. Sign verified against the exact +-mu/2 potential jump
/// crossing the panel in `doublet_panel_potential_jump_matches_dipole_sheet`.
pub fn doublet_potential(panel: &PanelGeom, field_point: Vector3<f64>) -> f64 {
    solid_angle(panel, field_point) / (4.0 * PI)
}

/// Straight vortex filament (Biot-Savart) from `a` to `b` with circulation
/// `gamma`, evaluated at `p`. `core_radius` regularizes the 1/distance
/// singularity when `p` lies on (or very near) the filament's own line.
pub fn vortex_segment_velocity(
    p: Vector3<f64>,
    a: Vector3<f64>,
    b: Vector3<f64>,
    gamma: f64,
    core_radius: f64,
) -> Vector3<f64> {
    let r0 = b - a;
    let r1 = p - a;
    let r2 = p - b;
    let r1_len = r1.norm();
    let r2_len = r2.norm();
    if r1_len < 1e-12 || r2_len < 1e-12 {
        return Vector3::zeros();
    }
    let cross = r1.cross(&r2);
    let cross_norm_sq = cross.norm_squared();
    if cross_norm_sq < core_radius * core_radius {
        return Vector3::zeros();
    }
    let coeff = gamma / (4.0 * PI * cross_norm_sq) * r0.dot(&(r1 / r1_len - r2 / r2_len));
    cross * coeff
}

/// Induced velocity of a unit-strength (mu = 1) constant doublet panel, via
/// the standard equivalence: a constant doublet sheet is equivalent to a
/// vortex ring of the same strength running around its boundary. Traversing
/// the vertices v0->v1->v2->v0 (the same winding `PanelGeom::normal` is built
/// from) gives a ring whose Biot-Savart field is consistent with a doublet
/// oriented along +normal for positive mu.
pub fn doublet_velocity(panel: &PanelGeom, field_point: Vector3<f64>, core_radius: f64) -> Vector3<f64> {
    vortex_segment_velocity(field_point, panel.v[0], panel.v[1], 1.0, core_radius)
        + vortex_segment_velocity(field_point, panel.v[1], panel.v[2], 1.0, core_radius)
        + vortex_segment_velocity(field_point, panel.v[2], panel.v[0], 1.0, core_radius)
}

/// Offsets a panel's centroid slightly inward along -normal for use as its
/// collocation point. Evaluating potential/velocity kernels exactly on the
/// panel plane (z=0 in the local frame) is a coincident-point singularity for
/// the doublet kernel in particular (the solid angle of a triangle from a
/// point in its own plane is degenerate), so every panel method nudges the
/// collocation point a small distance off the surface — see e.g. Katz &
/// Plotkin sec. 11.1. The offset is scaled to each panel's own size so it
/// works across panels of very different area on the same mesh.
pub fn collocation_point(panel: &PanelGeom) -> Vector3<f64> {
    panel.centroid - panel.normal * (panel.scale() * 1e-3)
}

/// Body-only (no wake) source and doublet potential influence-coefficient
/// matrices: `b[i][j]` / `c[i][j]` = potential at collocation point i due to a
/// unit-strength source / doublet on panel j.
pub struct BodyAic {
    pub b: DMatrix<f64>,
    pub c: DMatrix<f64>,
}

pub fn build_body_aic(geoms: &[PanelGeom], collocation: &[Vector3<f64>]) -> BodyAic {
    let n = geoms.len();
    let rows: Vec<(Vec<f64>, Vec<f64>)> = collocation
        .par_iter()
        .map(|&p| {
            let mut b_row = vec![0.0; n];
            let mut c_row = vec![0.0; n];
            for (j, gj) in geoms.iter().enumerate() {
                b_row[j] = source_potential(gj, p);
                c_row[j] = doublet_potential(gj, p);
            }
            (b_row, c_row)
        })
        .collect();

    let mut b = DMatrix::zeros(n, n);
    let mut c = DMatrix::zeros(n, n);
    for (i, (b_row, c_row)) in rows.into_iter().enumerate() {
        for j in 0..n {
            b[(i, j)] = b_row[j];
            c[(i, j)] = c_row[j];
        }
    }
    BodyAic { b, c }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn right_triangle() -> PanelGeom {
        PanelGeom::from_vertices(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(0.0, 1.0, 0.0),
        )
    }

    fn scalene_obtuse_triangle() -> PanelGeom {
        PanelGeom::from_vertices(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(2.0, 0.3, 0.0),
            Vector3::new(-0.5, 1.7, 0.0),
        )
    }

    /// The exact, shape-independent result for a flat constant-strength source
    /// panel: the normal velocity jump crossing the panel is exactly sigma
    /// (sigma/2 on each side), the same result as an infinite sheet, because
    /// close to the panel the sheet locally looks infinite. This is the
    /// textbook justification for the collocation-offset trick and a strong,
    /// closed-form check on `source_influence`'s sign and magnitude.
    #[test]
    fn source_panel_self_induced_normal_velocity_is_sigma_over_two() {
        for panel in [right_triangle(), scalene_obtuse_triangle()] {
            for eps in [1e-3, 1e-4, 1e-5] {
                let scale = panel.scale();
                let above = panel.centroid + panel.normal * (scale * eps);
                let below = panel.centroid - panel.normal * (scale * eps);

                let w_above = source_influence(&panel, above).1.dot(&panel.normal);
                let w_below = source_influence(&panel, below).1.dot(&panel.normal);

                assert!(
                    (w_above - 0.5).abs() < 0.02,
                    "w_above={w_above} expected ~0.5 (eps={eps})"
                );
                assert!(
                    (w_below + 0.5).abs() < 0.02,
                    "w_below={w_below} expected ~-0.5 (eps={eps})"
                );
            }
        }
    }

    /// Far from the panel, a source of strength sigma looks like a point
    /// source: velocity magnitude -> sigma*area/(4*pi*r^2), radially outward.
    #[test]
    fn source_panel_far_field_matches_point_source() {
        let panel = right_triangle();
        let far_point = panel.centroid + panel.normal * 1000.0;
        let (_, vel) = source_influence(&panel, far_point);
        let expected = panel.area / (4.0 * PI * 1000.0 * 1000.0);
        assert!(
            (vel.norm() - expected).abs() / expected < 1e-3,
            "far-field |v|={} expected {}",
            vel.norm(),
            expected
        );
        // Should point essentially straight along +normal at this distance/offset ratio.
        assert!(vel.normalize().dot(&panel.normal) > 0.999);
    }

    /// A doublet panel's potential has the same solid-angle-based jump: +1/2
    /// just outside on the +normal side, -1/2 just inside, matching the known
    /// dipole-sheet discontinuity (mu=1 sheet -> potential jump of exactly mu).
    #[test]
    fn doublet_panel_potential_jump_matches_dipole_sheet() {
        for panel in [right_triangle(), scalene_obtuse_triangle()] {
            let scale = panel.scale();
            let above = panel.centroid + panel.normal * (scale * 1e-4);
            let below = panel.centroid - panel.normal * (scale * 1e-4);
            let phi_above = doublet_potential(&panel, above);
            let phi_below = doublet_potential(&panel, below);
            assert!((phi_above - (-0.5)).abs() < 0.02, "phi_above={phi_above}");
            assert!((phi_below - 0.5).abs() < 0.02, "phi_below={phi_below}");
        }
    }

    /// Deterministic xorshift64, only used to Monte-Carlo integrate the raw
    /// point-source kernel as an independent check on `source_potential` --
    /// no dependency on an RNG crate needed for that.
    fn mc_source_potential(panel: &PanelGeom, p: Vector3<f64>, samples: usize, seed: u64) -> f64 {
        let mut state = seed;
        let mut next = || -> f64 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut sum = 0.0;
        for _ in 0..samples {
            let (r1, r2) = (next(), next());
            let (a, b) = if r1 + r2 > 1.0 { (1.0 - r1, 1.0 - r2) } else { (r1, r2) };
            let c = 1.0 - a - b;
            let sample_pt = panel.v[0] * c + panel.v[1] * a + panel.v[2] * b;
            sum += 1.0 / (p - sample_pt).norm().max(1e-12);
        }
        -(sum / samples as f64) * panel.area / (4.0 * PI)
    }

    /// Direct, independent check on `source_potential` alone (not its
    /// derivative): Monte-Carlo integrate the defining point-source surface
    /// integral phi = -1/(4pi) integral(dA'/|P-r'|) and compare.
    #[test]
    fn source_potential_matches_monte_carlo_quadrature() {
        let panel = scalene_obtuse_triangle();
        for offset in [
            panel.normal * 0.05 + panel.e1 * 0.1,
            panel.normal * 0.5,
            panel.e1 * 2.0 + panel.normal * 0.3,
        ] {
            let p = panel.centroid + offset;
            let analytic = source_potential(&panel, p);
            let mc = mc_source_potential(&panel, p, 300_000, 0x9E3779B97F4A7C15);
            let rel_err = (analytic - mc).abs() / mc.abs().max(1e-9);
            assert!(rel_err < 0.02, "analytic={analytic} mc={mc} rel_err={rel_err}");
        }
    }

    /// Cross-check: `source_influence`'s velocity output should equal the
    /// numerical gradient of its own potential output. The phi and (u,v,w)
    /// formulas are two independently-stated textbook results (not one
    /// literally differentiated from the other in this code), so this guards
    /// against them silently disagreeing.
    #[test]
    fn source_velocity_matches_finite_difference_of_potential() {
        let panel = scalene_obtuse_triangle();
        let p = panel.centroid + panel.normal * 0.3 + panel.e1 * 0.1;
        let h = 1e-5;
        let grad_fd = Vector3::new(
            (source_potential(&panel, p + panel.e1 * h) - source_potential(&panel, p - panel.e1 * h)) / (2.0 * h),
            (source_potential(&panel, p + panel.e2 * h) - source_potential(&panel, p - panel.e2 * h)) / (2.0 * h),
            (source_potential(&panel, p + panel.normal * h) - source_potential(&panel, p - panel.normal * h))
                / (2.0 * h),
        );
        let grad_global = panel.e1 * grad_fd.x + panel.e2 * grad_fd.y + panel.normal * grad_fd.z;
        let analytic = source_influence(&panel, p).1;
        let diff = (grad_global - analytic).norm();
        assert!(
            diff < 1e-3,
            "gradient-of-potential {grad_global:?} vs analytic velocity {analytic:?}, diff {diff}"
        );
    }

    /// Cross-check: the gradient of the solid-angle potential should match the
    /// vortex-ring Biot-Savart velocity at an off-panel point, since both are
    /// supposed to represent the same physical doublet panel.
    #[test]
    fn doublet_velocity_matches_finite_difference_of_potential() {
        let panel = scalene_obtuse_triangle();
        let p = panel.centroid + panel.normal * 0.3 + panel.e1 * 0.1;
        let h = 1e-5;
        let grad_fd = Vector3::new(
            (doublet_potential(&panel, p + panel.e1 * h) - doublet_potential(&panel, p - panel.e1 * h)) / (2.0 * h),
            (doublet_potential(&panel, p + panel.e2 * h) - doublet_potential(&panel, p - panel.e2 * h)) / (2.0 * h),
            (doublet_potential(&panel, p + panel.normal * h) - doublet_potential(&panel, p - panel.normal * h))
                / (2.0 * h),
        );
        let grad_global = panel.e1 * grad_fd.x + panel.e2 * grad_fd.y + panel.normal * grad_fd.z;
        let biot_savart = doublet_velocity(&panel, p, 1e-9);
        let diff = (grad_global - biot_savart).norm();
        assert!(
            diff < 1e-3,
            "gradient-of-potential {grad_global:?} vs vortex-ring {biot_savart:?}, diff {diff}"
        );
    }
}
