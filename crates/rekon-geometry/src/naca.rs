//! Parametric NACA airfoil sections and wing-mesh generation.
//!
//! Feeds the exact same import pipeline a real STL upload would (see
//! rekon-app's `pipeline::run_generated`): a generated wing gets identical
//! repair/panelize/voxelize/panel-method treatment to an uploaded one.
//!
//! Supported today: NACA 4-digit (any camber/position/thickness) and NACA
//! 5-digit NON-REFLEXED camber lines (the "series 2" designs — 210XX through
//! 250XX and their relatives, e.g. the famous 23012). Reflexed 5-digit
//! (three-digit code ending in 1, e.g. 23112) and the 6-series laminar-flow
//! family both require additional tabulated constants (a k2/k1 reflex ratio
//! table, and full 6-series thickness/camber tables respectively) that
//! aren't reproduced here with confidence — both are rejected with a clear
//! error rather than silently generating an approximate/wrong shape.

use std::f32::consts::PI;

use glam::Vec3;

use crate::mesh::Mesh;

/// A parametric airfoil section, normalized to unit chord (x, y both as
/// fractions of chord). `surface_at` is the only thing wing generation needs
/// from this type.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Airfoil {
    /// Standard NACA 4-digit: `camber` = max camber as a fraction of chord
    /// (the designation's first digit / 100), `camber_pos` = chordwise
    /// position of max camber as a fraction of chord (second digit / 10),
    /// `thickness` = max thickness as a fraction of chord (last two digits /
    /// 100). A symmetric section (NACA 00XX) has `camber == 0.0`.
    Naca4 { camber: f32, camber_pos: f32, thickness: f32 },
    /// Standard NACA 5-digit, non-reflexed camber line only. `design_cl` is
    /// the section design lift coefficient (`0.15 * first digit`, e.g. 0.3
    /// for the "2" in "23012"). `camber_pos_code` is the designation's
    /// second digit, one of 1..=5 (the only values with a published `r`/`k1`
    /// pair) mapping to a max-camber position of `code * 0.05` of chord.
    /// `thickness` is the last two digits / 100, same meaning as `Naca4`.
    Naca5 { design_cl: f32, camber_pos_code: u8, thickness: f32 },
}

#[derive(Debug, Clone, Copy, PartialEq, thiserror::Error)]
pub enum AirfoilParseError {
    #[error("NACA designation must be 4 or 5 digits, got {0:?}")]
    BadLength(usize),
    #[error("NACA designation must be all digits")]
    NotDigits,
    #[error("5-digit reflexed camber lines (Q=1) aren't supported yet — use a non-reflexed (Q=0) designation")]
    ReflexedUnsupported,
    #[error("5-digit camber position code must be 1-5 (max camber at 5%-25% chord), got {0}")]
    UnsupportedCamberPositionCode(u8),
    #[error("thickness must be a positive fraction of chord under 0.40, got {0}")]
    ThicknessOutOfRange(f32),
}

impl Airfoil {
    /// Parses a bare NACA digit string ("0012", "2412", "23012" — no "NACA"
    /// prefix). See the module doc for which families are supported.
    pub fn parse_naca(designation: &str) -> Result<Self, AirfoilParseError> {
        let s = designation.trim();
        if !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(AirfoilParseError::NotDigits);
        }
        let digits: Vec<u32> = s.bytes().map(|b| (b - b'0') as u32).collect();

        let airfoil = match digits.len() {
            4 => {
                let camber = digits[0] as f32 / 100.0;
                let camber_pos = digits[1] as f32 / 10.0;
                let thickness = (digits[2] * 10 + digits[3]) as f32 / 100.0;
                Airfoil::Naca4 { camber, camber_pos, thickness }
            }
            5 => {
                let l = digits[0];
                let p = digits[1];
                let q = digits[2];
                if q != 0 {
                    return Err(AirfoilParseError::ReflexedUnsupported);
                }
                if !(1..=5).contains(&p) {
                    return Err(AirfoilParseError::UnsupportedCamberPositionCode(p as u8));
                }
                let thickness = (digits[3] * 10 + digits[4]) as f32 / 100.0;
                Airfoil::Naca5 { design_cl: 0.15 * l as f32, camber_pos_code: p as u8, thickness }
            }
            n => return Err(AirfoilParseError::BadLength(n)),
        };

        let thickness = airfoil.thickness_frac();
        if !(thickness > 0.0 && thickness < 0.40) {
            return Err(AirfoilParseError::ThicknessOutOfRange(thickness));
        }
        Ok(airfoil)
    }

    pub fn thickness_frac(&self) -> f32 {
        match *self {
            Airfoil::Naca4 { thickness, .. } => thickness,
            Airfoil::Naca5 { thickness, .. } => thickness,
        }
    }

    /// Camber line height and slope at chordwise fraction `x` (0..1).
    fn camber_at(&self, x: f32) -> (f32, f32) {
        match *self {
            Airfoil::Naca4 { camber: m, camber_pos: p, .. } => naca4_camber(m, p, x),
            Airfoil::Naca5 { design_cl, camber_pos_code, .. } => naca5_camber(design_cl, camber_pos_code, x),
        }
    }

    /// Upper and lower surface points `([x, y])` at nominal chordwise
    /// fraction `x` (0..1), both offset perpendicular to the local camber
    /// line by the half-thickness — the standard NACA construction, not a
    /// naive vertical thickness offset.
    pub fn surface_at(&self, x: f32) -> ([f32; 2], [f32; 2]) {
        let x = x.clamp(0.0, 1.0);
        let yt = half_thickness(self.thickness_frac(), x);
        let (yc, dyc_dx) = self.camber_at(x);
        let theta = dyc_dx.atan();
        let (sin_t, cos_t) = theta.sin_cos();
        let upper = [x - yt * sin_t, yc + yt * cos_t];
        let lower = [x + yt * sin_t, yc - yt * cos_t];
        (upper, lower)
    }
}

/// Standard NACA 4-digit thickness distribution (closed trailing edge —
/// the `-0.1036` last coefficient, vs. `-0.1015` for the classic
/// slightly-open-TE form; a closed TE keeps the generated mesh watertight,
/// which this pipeline's voxelizer and panel method both want). Verified
/// exactly closed: 0.2969-0.1260-0.3516+0.2843-0.1036 == 0.0 at x=1.
fn half_thickness(t: f32, x: f32) -> f32 {
    5.0 * t * (0.2969 * x.sqrt() - 0.1260 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x)
}

fn naca4_camber(m: f32, p: f32, x: f32) -> (f32, f32) {
    if m == 0.0 || p == 0.0 {
        return (0.0, 0.0);
    }
    if x < p {
        let yc = (m / (p * p)) * (2.0 * p * x - x * x);
        let dyc = (2.0 * m / (p * p)) * (p - x);
        (yc, dyc)
    } else {
        let yc = (m / ((1.0 - p) * (1.0 - p))) * ((1.0 - 2.0 * p) + 2.0 * p * x - x * x);
        let dyc = (2.0 * m / ((1.0 - p) * (1.0 - p))) * (p - x);
        (yc, dyc)
    }
}

/// Non-reflexed 5-digit camber line (Abbott & von Doenhoff's `r`/`k1`
/// constants, tabulated per camber-position code — there is no closed-form
/// derivation of these from the designation alone). Tabulated for a design
/// Cl of 0.3 (the historical "2" series); scaled linearly for other design
/// Cl values, which the derivation shows is exact for a fixed `r`.
fn naca5_camber(design_cl: f32, camber_pos_code: u8, x: f32) -> (f32, f32) {
    let (r, k1): (f32, f32) = match camber_pos_code {
        1 => (0.0580, 361.4),
        2 => (0.1260, 51.64),
        3 => (0.2025, 15.957),
        4 => (0.2900, 6.643),
        5 => (0.3910, 3.230),
        _ => unreachable!("validated in Airfoil::parse_naca"),
    };
    let scale = design_cl / 0.3;
    if x < r {
        let yc = scale * (k1 / 6.0) * (x * x * x - 3.0 * r * x * x + r * r * (3.0 - r) * x);
        let dyc = scale * (k1 / 6.0) * (3.0 * x * x - 6.0 * r * x + r * r * (3.0 - r));
        (yc, dyc)
    } else {
        let yc = scale * (k1 / 6.0) * r * r * r * (1.0 - x);
        let dyc = scale * (-k1 / 6.0) * r * r * r;
        (yc, dyc)
    }
}

/// Full wing planform + section parameters for `generate_wing`. Sections are
/// placed at `n_span_stations` stations per half-span (root shared, so the
/// mesh always covers the full, mirrored `span_m`).
#[derive(Debug, Clone, Copy)]
pub struct WingParams {
    pub airfoil: Airfoil,
    /// Full tip-to-tip span, in meters.
    pub span_m: f32,
    pub root_chord_m: f32,
    pub tip_chord_m: f32,
    /// Leading-edge sweep; positive sweeps the tip aft (+X).
    pub sweep_deg: f32,
    /// Positive dihedral raises the tips. Modeled as a per-station vertical
    /// offset proportional to `|z| * tan(dihedral)` (the standard
    /// small-planform approximation), not a full section rotation.
    pub dihedral_deg: f32,
    /// Linear washout from root (0) to tip (`washout_deg`); negative
    /// reduces tip angle of attack relative to root, the usual sense of
    /// "washout" on a flying wing. Twist is applied about each station's
    /// quarter-chord.
    pub washout_deg: f32,
    /// Chordwise resolution (vertices per surface, LE to TE); minimum 4.
    pub n_chord_stations: usize,
    /// Spanwise resolution PER HALF-SPAN, root included; minimum 2 (root +
    /// 1 more station). Total spanwise stations = `2 * n - 1`.
    pub n_span_stations: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum WingParamError {
    #[error("span must be positive")]
    SpanNotPositive,
    #[error("root and tip chord must both be positive")]
    ChordNotPositive,
    #[error("n_chord_stations must be at least 4")]
    TooFewChordStations,
    #[error("n_span_stations must be at least 2 (root + 1 more)")]
    TooFewSpanStations,
}

/// Builds a full (mirrored, root-to-tip-to-tip) wing mesh from `params`, a
/// ruled surface of `Airfoil::surface_at` sections swept/tapered/twisted per
/// station. Cosine chordwise clustering and the upper/lower diagonal-split
/// triangulation are the same pattern proven correct (mirror symmetry,
/// exact top/bottom panel correspondence) by this codebase's own tapered/
/// swept wing regression tests in `rekon-panel`.
pub fn generate_wing(params: &WingParams) -> Result<Mesh, WingParamError> {
    if !(params.span_m > 0.0) {
        return Err(WingParamError::SpanNotPositive);
    }
    if !(params.root_chord_m > 0.0) || !(params.tip_chord_m > 0.0) {
        return Err(WingParamError::ChordNotPositive);
    }
    if params.n_chord_stations < 4 {
        return Err(WingParamError::TooFewChordStations);
    }
    if params.n_span_stations < 2 {
        return Err(WingParamError::TooFewSpanStations);
    }

    let half_span = params.span_m * 0.5;
    let n_chord = params.n_chord_stations;
    let n_span = 2 * params.n_span_stations - 1; // root shared between halves

    let x_at = |i: usize| -> f32 {
        let s = i as f32 / (n_chord - 1) as f32;
        0.5 * (1.0 - (s * PI).cos())
    };

    let sweep = params.sweep_deg.to_radians();
    let dihedral = params.dihedral_deg.to_radians();
    let washout = params.washout_deg.to_radians();
    let pivot_x_frac = 0.25;

    let n_per_ring = 2 * (n_chord - 1);
    let mut vertices = Vec::with_capacity(n_span * n_per_ring);
    // Per-ring (z, chord, le_x, y_dihedral) — used to build the tip end caps.
    let mut ring_meta = Vec::with_capacity(n_span);

    for k in 0..n_span {
        let t = k as f32 / (n_span - 1) as f32; // 0..1 across the whole span
        let z = -half_span + t * params.span_m;
        let s = (z.abs() / half_span).clamp(0.0, 1.0); // 0 at root, 1 at tip
        let chord = params.root_chord_m + (params.tip_chord_m - params.root_chord_m) * s;
        let le_x = sweep.tan() * z.abs();
        let y_dihedral = dihedral.tan() * z.abs();
        let twist = washout * s;
        let (sin_tw, cos_tw) = twist.sin_cos();

        ring_meta.push((z, chord, le_x, y_dihedral));

        let place = |xf: f32, yf: f32| -> Vec3 {
            let x = xf * chord;
            let y = yf * chord;
            let px = pivot_x_frac * chord;
            let dx = x - px;
            let dy = y;
            let xt = px + dx * cos_tw - dy * sin_tw;
            let yt = dy * cos_tw + dx * sin_tw;
            Vec3::new(le_x + xt, y_dihedral + yt, z)
        };

        for i in 0..n_chord {
            let xf = x_at(i);
            let (upper, _lower) = params.airfoil.surface_at(xf);
            vertices.push(place(upper[0], upper[1]));
        }
        for i in (1..n_chord - 1).rev() {
            let xf = x_at(i);
            let (_upper, lower) = params.airfoil.surface_at(xf);
            vertices.push(place(lower[0], lower[1]));
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
            // Upper-role quads split a-c, lower-role quads split b-d: keeps
            // every lower triangle the exact vertex-for-vertex mirror of its
            // upper counterpart (see aero_coeffs.rs's tapered_smooth_wing
            // fixture, where a uniform split was found to break symmetry).
            if i < n_chord - 1 {
                triangles.push([a, b, c]);
                triangles.push([a, c, d]);
            } else {
                triangles.push([a, b, d]);
                triangles.push([b, c, d]);
            }
        }
    }

    for &k in &[0, n_span - 1] {
        let (z, chord, le_x, y_dihedral) = ring_meta[k];
        let centroid_idx = vertices.len() as u32;
        vertices.push(Vec3::new(le_x + chord * 0.5, y_dihedral, z));
        for i in 0..n_per_ring {
            triangles.push([centroid_idx, ring_index(k, i), ring_index(k, i + 1)]);
        }
    }

    Ok(Mesh { vertices, triangles })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_4_digit_designation() {
        let a = Airfoil::parse_naca("2412").unwrap();
        assert_eq!(a, Airfoil::Naca4 { camber: 0.02, camber_pos: 0.4, thickness: 0.12 });
    }

    #[test]
    fn parses_symmetric_4_digit_designation() {
        let a = Airfoil::parse_naca("0012").unwrap();
        assert_eq!(a, Airfoil::Naca4 { camber: 0.0, camber_pos: 0.0, thickness: 0.12 });
    }

    #[test]
    fn parses_5_digit_non_reflexed_designation() {
        let a = Airfoil::parse_naca("23012").unwrap();
        assert_eq!(a, Airfoil::Naca5 { design_cl: 0.3, camber_pos_code: 3, thickness: 0.12 });
    }

    #[test]
    fn rejects_reflexed_5_digit_designation() {
        assert_eq!(Airfoil::parse_naca("23112"), Err(AirfoilParseError::ReflexedUnsupported));
    }

    #[test]
    fn rejects_unsupported_camber_position_code() {
        assert_eq!(Airfoil::parse_naca("26012"), Err(AirfoilParseError::UnsupportedCamberPositionCode(6)));
    }

    #[test]
    fn rejects_wrong_length_and_non_digit_designations() {
        assert_eq!(Airfoil::parse_naca("123"), Err(AirfoilParseError::BadLength(3)));
        assert_eq!(Airfoil::parse_naca("12a2"), Err(AirfoilParseError::NotDigits));
    }

    #[test]
    fn rejects_zero_thickness() {
        assert_eq!(Airfoil::parse_naca("0000"), Err(AirfoilParseError::ThicknessOutOfRange(0.0)));
    }

    #[test]
    fn symmetric_airfoil_has_mirrored_upper_and_lower_surfaces() {
        let a = Airfoil::parse_naca("0012").unwrap();
        for i in 0..=20 {
            let x = i as f32 / 20.0;
            let (upper, lower) = a.surface_at(x);
            assert!((upper[0] - lower[0]).abs() < 1e-6, "x mismatch at {x}");
            assert!((upper[1] + lower[1]).abs() < 1e-6, "y should be mirrored at {x}");
        }
    }

    #[test]
    fn cambered_airfoil_upper_and_lower_are_not_mirrored() {
        let a = Airfoil::parse_naca("2412").unwrap();
        let (upper, lower) = a.surface_at(0.4);
        assert!((upper[1] + lower[1]).abs() > 1e-3, "cambered section should not be top/bottom symmetric");
    }

    #[test]
    fn thickness_distribution_closes_at_trailing_edge() {
        assert!(half_thickness(0.12, 1.0).abs() < 1e-5);
    }

    #[test]
    fn max_thickness_is_close_to_nominal() {
        let t = 0.12;
        let max_yt = (0..=1000).map(|i| half_thickness(t, i as f32 / 1000.0)).fold(0.0f32, f32::max);
        // The NACA 4-digit polynomial fit doesn't hit its nominal thickness
        // exactly (a well-known property of the fit) — within half a
        // percent of chord is the expected/accepted tolerance.
        assert!((max_yt * 2.0 - t).abs() < 0.005, "max thickness {} should be near nominal {}", max_yt * 2.0, t);
    }

    #[test]
    fn generate_wing_rejects_invalid_params() {
        let base = WingParams {
            airfoil: Airfoil::parse_naca("0012").unwrap(),
            span_m: 1.0,
            root_chord_m: 0.2,
            tip_chord_m: 0.2,
            sweep_deg: 0.0,
            dihedral_deg: 0.0,
            washout_deg: 0.0,
            n_chord_stations: 12,
            n_span_stations: 8,
        };
        assert_eq!(generate_wing(&WingParams { span_m: 0.0, ..base }).unwrap_err(), WingParamError::SpanNotPositive);
        assert_eq!(generate_wing(&WingParams { root_chord_m: 0.0, ..base }).unwrap_err(), WingParamError::ChordNotPositive);
        assert_eq!(generate_wing(&WingParams { n_chord_stations: 3, ..base }).unwrap_err(), WingParamError::TooFewChordStations);
        assert_eq!(generate_wing(&WingParams { n_span_stations: 1, ..base }).unwrap_err(), WingParamError::TooFewSpanStations);
    }

    #[test]
    fn generate_wing_produces_watertight_mesh() {
        let params = WingParams {
            airfoil: Airfoil::parse_naca("2412").unwrap(),
            span_m: 1.2,
            root_chord_m: 0.25,
            tip_chord_m: 0.12,
            sweep_deg: 15.0,
            dihedral_deg: 3.0,
            washout_deg: -2.0,
            n_chord_stations: 14,
            n_span_stations: 10,
        };
        let mesh = generate_wing(&params).unwrap();
        let (_, report) = crate::mesh_repair::repair(&mesh, 1e-5);
        assert_eq!(report.open_edges, 0, "generated wing should be watertight");
        assert_eq!(report.degenerate_removed, 0, "generated wing shouldn't contain degenerate triangles");
    }

    #[test]
    fn generate_wing_spans_requested_extent() {
        let params = WingParams {
            airfoil: Airfoil::parse_naca("0012").unwrap(),
            span_m: 2.0,
            root_chord_m: 0.3,
            tip_chord_m: 0.3,
            sweep_deg: 0.0,
            dihedral_deg: 0.0,
            washout_deg: 0.0,
            n_chord_stations: 10,
            n_span_stations: 6,
        };
        let mesh = generate_wing(&params).unwrap();
        let bbox = mesh.bounding_box();
        assert!((bbox.size().z - 2.0).abs() < 1e-4, "span extent {} should be ~2.0", bbox.size().z);
        assert!((bbox.size().x - 0.3).abs() < 1e-3, "chord extent {} should be ~0.3 for untapered wing", bbox.size().x);
    }
}
