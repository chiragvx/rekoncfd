//! Trim-angle search and static-margin estimation. Every point evaluated here
//! is a cheap cached-LU back-substitution (see `solve::PanelModel::solve`) --
//! a full trim search or a multi-point polar sweep costs a handful of those,
//! never a re-factorization of the doublet matrix.

use nalgebra::Vector3;
use thiserror::Error;

use crate::aero_coeffs::{solve_and_integrate, Coefficients};
use crate::solve::{Freestream, PanelError, PanelModel};

#[derive(Debug, Error)]
pub enum TrimError {
    #[error(transparent)]
    Panel(#[from] PanelError),
    #[error("Cm does not change sign between alpha={alpha_lo} deg (Cm={cm_lo}) and alpha={alpha_hi} deg (Cm={cm_hi}) -- no trim point in this bracket")]
    NoSignChange { alpha_lo: f64, cm_lo: f64, alpha_hi: f64, cm_hi: f64 },
}

/// One angle-of-attack sample of a polar sweep.
#[derive(Debug, Clone, Copy)]
pub struct PolarPoint {
    pub alpha_deg: f64,
    pub coefficients: Coefficients,
}

/// Evaluates `coefficients` at each of `alphas_deg`, reusing the same cached
/// LU factorization for every point (only `PanelModel::build` factorizes).
pub fn polar(model: &PanelModel, v_inf: f64, cg: Vector3<f64>, alphas_deg: &[f64]) -> Result<Vec<PolarPoint>, PanelError> {
    alphas_deg
        .iter()
        .map(|&alpha_deg| {
            let coefficients = solve_and_integrate(model, Freestream { alpha_deg, v_inf }, cg)?;
            Ok(PolarPoint { alpha_deg, coefficients })
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
pub struct TrimResult {
    pub alpha_deg: f64,
    pub cl: f64,
    pub cm: f64,
    /// `-d(Cm)/d(CL)` about `cg`, evaluated near the trim point: positive
    /// means `cg` sits ahead of the neutral point (statically stable -- a
    /// nose-up disturbance reduces CL's nose-up contribution back down),
    /// negative means behind it (unstable).
    pub static_margin: f64,
}

/// Finds the trim angle of attack (`Cm(alpha) = 0` about `cg`) by bisection
/// over `[alpha_lo_deg, alpha_hi_deg]`, which must bracket a sign change.
/// Bisection (not Newton/secant) is deliberate: it never diverges and needs
/// no derivative estimate, and since each evaluation is already cheap
/// (cached-LU back-substitution, not a re-solve), bisection's slower
/// convergence rate costs at most a handful of extra evaluations in
/// practice.
pub fn find_trim(
    model: &PanelModel,
    v_inf: f64,
    cg: Vector3<f64>,
    alpha_lo_deg: f64,
    alpha_hi_deg: f64,
    tol_deg: f64,
    max_iter: usize,
) -> Result<TrimResult, TrimError> {
    let cm_at = |alpha_deg: f64| -> Result<f64, PanelError> {
        Ok(solve_and_integrate(model, Freestream { alpha_deg, v_inf }, cg)?.cm)
    };

    let (mut lo, mut hi) = (alpha_lo_deg, alpha_hi_deg);
    let mut cm_lo = cm_at(lo)?;
    let cm_hi = cm_at(hi)?;
    if cm_lo == 0.0 {
        return finalize_trim(model, v_inf, cg, lo);
    }
    if cm_hi == 0.0 {
        return finalize_trim(model, v_inf, cg, hi);
    }
    if cm_lo.signum() == cm_hi.signum() {
        return Err(TrimError::NoSignChange { alpha_lo: lo, cm_lo, alpha_hi: hi, cm_hi });
    }

    let mut mid = 0.5 * (lo + hi);
    for _ in 0..max_iter {
        mid = 0.5 * (lo + hi);
        if (hi - lo).abs() < tol_deg {
            break;
        }
        let cm_mid = cm_at(mid)?;
        if cm_mid == 0.0 {
            break;
        }
        if cm_mid.signum() == cm_lo.signum() {
            lo = mid;
            cm_lo = cm_mid;
        } else {
            hi = mid;
        }
    }

    finalize_trim(model, v_inf, cg, mid)
}

fn finalize_trim(model: &PanelModel, v_inf: f64, cg: Vector3<f64>, alpha_deg: f64) -> Result<TrimResult, TrimError> {
    let coeffs = solve_and_integrate(model, Freestream { alpha_deg, v_inf }, cg)?;
    let static_margin = static_margin_at(model, v_inf, cg, alpha_deg)?;
    Ok(TrimResult { alpha_deg, cl: coeffs.cl, cm: coeffs.cm, static_margin })
}

/// `-d(Cm)/d(CL)` about `cg`, via a small central-difference bracket in
/// alpha around `alpha_deg`.
pub fn static_margin_at(model: &PanelModel, v_inf: f64, cg: Vector3<f64>, alpha_deg: f64) -> Result<f64, PanelError> {
    const DELTA_DEG: f64 = 0.5;
    let lo = solve_and_integrate(model, Freestream { alpha_deg: alpha_deg - DELTA_DEG, v_inf }, cg)?;
    let hi = solve_and_integrate(model, Freestream { alpha_deg: alpha_deg + DELTA_DEG, v_inf }, cg)?;
    let dcl = hi.cl - lo.cl;
    if dcl.abs() < 1e-9 {
        return Ok(0.0);
    }
    Ok(-(hi.cm - lo.cm) / dcl)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solve::PanelConfig;

    fn symmetric_wing_model() -> PanelModel {
        let raw = crate::fixtures::smooth_symmetric_wing(1.0, 0.2, 0.02, 14, 10);
        let (mesh, _) = rekon_geometry::repair(&raw, 1e-5);
        PanelModel::build(&mesh, PanelConfig::default()).expect("builds")
    }

    #[test]
    fn finds_trim_at_zero_alpha_for_symmetric_wing() {
        let model = symmetric_wing_model();
        // A symmetric (no camber, no reflex) wing has Cm_AC = 0 for all alpha,
        // so Cm about ANY cg is proportional to CL, which is itself ~0 only
        // at alpha=0 -- trim should land there regardless of cg position.
        let cg = Vector3::new(0.05, 0.0, 0.0);
        let trim = find_trim(&model, 20.0, cg, -6.0, 6.0, 0.02, 30).expect("finds trim");
        eprintln!("trim: {trim:?}");
        assert!(trim.alpha_deg.abs() < 0.1, "expected trim near alpha=0, got {}", trim.alpha_deg);
        assert!(trim.cm.abs() < 0.01, "Cm at trim should be ~0, got {}", trim.cm);
    }

    #[test]
    fn static_margin_is_positive_for_forward_cg_and_negative_for_aft_cg() {
        let model = symmetric_wing_model();
        // Static margin depends only on (cg - neutral_point), not on the
        // camber-driven trim CROSSING point -- meaningful to check even on a
        // symmetric wing whose trim is always alpha=0.
        let forward_cg = Vector3::new(-0.05, 0.0, 0.0); // well ahead of the ~quarter-chord AC
        let aft_cg = Vector3::new(0.19, 0.0, 0.0); // well aft, past the AC

        let sm_forward = static_margin_at(&model, 20.0, forward_cg, 3.0).expect("computes");
        let sm_aft = static_margin_at(&model, 20.0, aft_cg, 3.0).expect("computes");
        eprintln!("static margin: forward_cg={sm_forward} aft_cg={sm_aft}");

        assert!(sm_forward > 0.0, "forward cg should be statically stable (positive margin), got {sm_forward}");
        assert!(sm_aft < 0.0, "aft cg (past the AC) should be statically unstable (negative margin), got {sm_aft}");
    }

    #[test]
    fn polar_sweep_matches_individual_solves() {
        let model = symmetric_wing_model();
        let cg = Vector3::new(0.05, 0.0, 0.0);
        let alphas = [-2.0, 0.0, 2.0, 4.0];
        let points = polar(&model, 20.0, cg, &alphas).expect("sweeps");
        assert_eq!(points.len(), alphas.len());
        for (p, &alpha) in points.iter().zip(&alphas) {
            assert_eq!(p.alpha_deg, alpha);
            let direct = solve_and_integrate(&model, Freestream { alpha_deg: alpha, v_inf: 20.0 }, cg).expect("solves");
            assert!((p.coefficients.cl - direct.cl).abs() < 1e-9);
        }
    }
}
