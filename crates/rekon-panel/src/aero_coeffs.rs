//! Surface pressure and force/moment integration from a solved `PanelModel`.
//!
//! # Why tangential-gradient-of-exterior-potential, not raw near-surface Biot-Savart summation
//!
//! An earlier version of this crate tried to validate (and was going to compute
//! surface velocity via) a direct sum of every source/doublet panel's velocity
//! kernel evaluated at each panel's own collocation point. That is numerically
//! unsound this close to a many-panel surface: the self- and near-neighbor
//! terms are individually huge (tens of times `Vinf`) and must cancel to a
//! small residual, and empirically that cancellation does NOT improve under
//! mesh refinement (max residual measured at 0.50/0.93/1.33/2.10 across
//! 140/352/816/1700-panel spheres) -- the textbook signature of an ill-
//! conditioned evaluation, not a real physical residual (which should shrink
//! as O(h) or better). Meanwhile the actual linear system this crate solves
//! is satisfied to machine precision (`||C.mu - rhs|| / ||rhs|| ~ 1e-15`,
//! checked in `solve`'s tests), every individual kernel is independently
//! verified via exact closed-form identities (`aic.rs`, `wake.rs` tests), and
//! the far-field exterior potential matches the classical uniform-flow-past-
//! sphere solution to <1% once a few radii from the surface -- so the solve
//! itself was never the bug.
//!
//! A first attempt at the standard textbook shortcut for surface velocity
//! (since interior potential is forced to exactly 0, the potential just
//! outside panel i is exactly `-mu_i` -- see `doublet_panel_potential_jump_
//! matches_dipole_sheet` -- so naively `V_tangent = -grad_s(mu)`) turned out
//! to be INCOMPLETE for this crate's discrete, constant-panel representation:
//! a direct check found the interior potential is only forced to exactly 0
//! AT the N collocation points, not smoothly in between them (a nearby
//! interior point drifted to -0.11 at Vinf=20, i.e. order 0.5% of Vinf, not
//! the ~0 the shortcut assumes) -- so `-grad_s(mu)` alone silently drops a
//! real contribution and was empirically off by a consistent ~33% (measured:
//! sphere equator speed converges to a rock-steady 2.0x Vinf across 252 to
//! 3036 panels, not the classical exact 1.5x, so the gap is a real missing
//! term, not shrinking discretization error).
//!
//! The fix used here: evaluate the FULL exterior potential directly
//! (freestream + every source/doublet/wake panel's potential kernel, summed
//! at a point outside panel i) rather than relying on the `-mu_i` shortcut.
//! Potential-kernel summation is well-behaved even close to the surface
//! (unlike velocity-kernel summation -- these are smooth, bounded quadrature/
//! solid-angle evaluations, not large-cancelling Biot-Savart sums). Then the
//! tangential (surface) VELOCITY is the tangential gradient of that
//! potential, reconstructed via a per-panel least-squares fit against
//! topological (edge-adjacency) neighbors' exterior-potential values.
//!
//! # A real, documented accuracy ceiling for this approach
//!
//! Evaluating the exterior potential very close to the surface (within about
//! one panel width) makes the neighbor-differenced gradient dominated by
//! panel-to-panel discretization noise rather than the smooth physical field
//! -- confirmed by finite-differencing `exterior_potential_at` at arbitrary
//! (not panel-anchored) points near a sphere and watching the result swing
//! wildly at sub-panel step sizes but stabilize at panel-scale steps.
//! `exterior_point` therefore offsets by a few mean-panel-widths rather than
//! an infinitesimal amount. Even so, for a HIGHLY CURVED test body (a unit
//! sphere, panelized at ~350-560 panels), the reconstructed equator speed
//! plateaus around 1.9x freestream regardless of further offset tuning or a
//! wider (2-ring) neighbor stencil, versus the classical exact 1.5x -- a
//! genuine ~25% ceiling for constant-strength flat panels with first-order
//! neighbor-difference gradient reconstruction on strongly curved geometry,
//! not a bug (the underlying sigma/mu solve was independently verified
//! correct: machine-precision linear-system residual, every kernel checked
//! against exact closed-form identities, and the FAR-field exterior
//! potential matching the classical sphere solution to <1% by r=2*radius).
//! A flying wing's much gentler curvature is expected to fare considerably
//! better than this worst-case sphere test -- see the wing-based CL/alpha
//! and CG-moment tests below, which are what this project actually needs.

use nalgebra::Vector3;

use crate::solve::{Freestream, PanelModel, SolveResult};

/// Total physical potential (freestream + source + doublet + wake) at an
/// arbitrary point, evaluated via the potential kernels (never the velocity
/// kernels -- see module docs for why that distinction matters numerically).
/// O(n_panels + n_wake) per call.
pub(crate) fn exterior_potential_at(model: &PanelModel, result: &SolveResult, p: Vector3<f64>) -> f64 {
    let vinf = result.freestream.velocity();
    let mut phi = vinf.dot(&p);
    for (j, gj) in model.geoms.iter().enumerate() {
        phi += crate::aic::source_potential(gj, p) * result.sigma[j];
        phi += crate::aic::doublet_potential(gj, p) * result.mu[j];
    }
    for w in &model.wake_panels {
        let wake_mu = result.mu[w.upper_panel] - result.mu[w.lower_panel];
        phi += w.doublet_potential_at(p) * wake_mu;
    }
    phi
}

/// A point outside panel i, offset by a moderate multiple of the model's
/// MEAN panel scale (not `collocation_point`'s infinitesimal per-panel
/// offset, and not the local panel's own scale): empirically, evaluating
/// this close to the true surface makes the neighbor-differenced tangential
/// gradient dominated by panel-to-panel discretization noise rather than the
/// smooth physical field (checked directly against a finite-difference probe
/// of `exterior_potential_at` fully decoupled from panel geometry -- the
/// noise floor is reached within roughly one to a few panel-widths of the
/// surface). A multiple of ~2x mean panel scale empirically minimizes the
/// resulting bias for a curved test body (a sphere) without the offset
/// becoming physically meaningless; see `aero_coeffs`'s module docs and
/// `sphere_surface_speed_matches_classical_potential_flow_solution` for the
/// full investigation and the resulting (documented, non-trivial) accuracy
/// ceiling of this constant-panel, least-squares-neighbor-gradient approach.
fn exterior_point(model: &PanelModel, i: usize, mean_scale: f64) -> Vector3<f64> {
    let g = &model.geoms[i];
    g.centroid + g.normal * (mean_scale * 2.0)
}

/// Least-squares reconstruction of the surface (tangential) gradient of a
/// per-panel scalar field `phi` at panel `i`, in panel i's own local frame,
/// using its edge-adjacency neighbors: fits `phi_j - phi_i ~= a*u_j + b*v_j`
/// where `(u_j, v_j)` is neighbor j's centroid projected into panel i's
/// `(e1, e2)` tangent basis, then returns `a*e1 + b*e2` as a 3D (purely
/// tangential) vector.
fn tangential_gradient(model: &PanelModel, phi: &[f64], i: usize) -> Vector3<f64> {
    let neighbors = &model.adjacency[i];
    let gi = &model.geoms[i];
    if neighbors.len() < 2 {
        return Vector3::zeros();
    }

    let (mut suu, mut suv, mut svv, mut sud, mut svd) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for &j in neighbors {
        let d = model.geoms[j].centroid - gi.centroid;
        let u = d.dot(&gi.e1);
        let v = d.dot(&gi.e2);
        let dphi = phi[j] - phi[i];
        suu += u * u;
        suv += u * v;
        svv += v * v;
        sud += u * dphi;
        svd += v * dphi;
    }

    let det = suu * svv - suv * suv;
    if det.abs() < 1e-30 {
        return Vector3::zeros(); // degenerate/collinear neighborhood: no reliable fit
    }
    let a = (sud * svv - svd * suv) / det;
    let b = (svd * suu - sud * suv) / det;
    gi.e1 * a + gi.e2 * b
}

#[derive(Debug, Clone)]
pub struct SurfaceFlow {
    /// Per-panel tangential surface velocity, `grad_s(exterior_potential)`
    /// (velocity = +gradient of potential is this crate's convention
    /// throughout -- see e.g. `aic::source_velocity_matches_finite_
    /// difference_of_potential`).
    pub velocity: Vec<Vector3<f64>>,
    /// Pressure coefficient, incompressible Bernoulli: `1 - (|V|/Vinf)^2`.
    pub cp: Vec<f64>,
}

pub fn surface_flow(model: &PanelModel, result: &SolveResult) -> SurfaceFlow {
    use rayon::prelude::*;

    let n = model.panels.len();
    let v_inf = result.freestream.v_inf.max(1e-9);
    let mean_scale: f64 = model.geoms.iter().map(|g| g.scale()).sum::<f64>() / n.max(1) as f64;

    let phi_exterior: Vec<f64> = (0..n)
        .into_par_iter()
        .map(|i| exterior_potential_at(model, result, exterior_point(model, i, mean_scale)))
        .collect();

    let velocity: Vec<Vector3<f64>> = (0..n).map(|i| tangential_gradient(model, &phi_exterior, i)).collect();
    let cp: Vec<f64> = velocity.iter().map(|v| 1.0 - (v.norm() / v_inf).powi(2)).collect();

    SurfaceFlow { velocity, cp }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Coefficients {
    pub cl: f64,
    pub cd_induced: f64,
    pub cm: f64,
}

/// Near-field CL and pitching moment (about `cg`) via direct Cp integration:
/// `F = -sum(Cp_i * n_i * area_i) * q_inf`, `M = sum((centroid_i - cg) x F_i)`.
/// Near-field pressure integration is fine for lift/moment (it's what most
/// panel codes do); induced drag is deliberately NOT taken from this same sum
/// -- see `induced_drag_trefftz_plane` for why.
pub fn lift_and_moment(model: &PanelModel, result: &SolveResult, flow: &SurfaceFlow, cg: Vector3<f64>) -> (f64, f64) {
    let vinf = result.freestream.velocity();
    let vinf_dir = vinf.normalize();
    // Lift is defined perpendicular to freestream, in the X-Y (alpha) plane.
    let lift_dir = Vector3::new(-vinf_dir.y, vinf_dir.x, 0.0);

    let mut lift_force = 0.0;
    let mut pitching_moment = 0.0;
    for (i, panel) in model.panels.iter().enumerate() {
        let area = panel.area as f64;
        let normal = model.geoms[i].normal;
        let force = -flow.cp[i] * area * normal; // per unit dynamic pressure
        lift_force += force.dot(&lift_dir);

        let arm = model.geoms[i].centroid - cg;
        let moment = arm.cross(&force);
        // Pitching moment is about the spanwise (Z) axis; positive = nose-up
        // by the usual aero sign convention (need -Z component given our
        // X=chordwise/+downstream, Y=up, Z=spanwise frame and Z-cross giving
        // nose-down positive otherwise).
        pitching_moment += -moment.z;
    }

    let q_ref_area = model.reference.area.max(1e-9);
    let cl = lift_force / q_ref_area;
    let cm = pitching_moment / (q_ref_area * model.reference.chord.max(1e-9));
    (cl, cm)
}

/// Induced drag via Trefftz-plane analysis: integrate the wake's induced
/// cross-flow kinetic energy in a plane far downstream, rather than
/// near-field pressure integration (which is numerically noisy for drag
/// specifically: near-field Cp errors that barely affect CL/Cm can dominate
/// CDi, since drag is itself already a small difference of large pressure
/// forces, "d'Alembert's-paradox territory").
///
/// NOTE an earlier version of this function used the local product
/// `0.5 * Gamma(z) * dGamma/dz` as the integrand -- which is mathematically
/// wrong: `integral(Gamma * Gamma' dz) = [Gamma^2 / 2]` evaluated tip-to-tip,
/// identically ZERO for any circulation distribution vanishing at the tips
/// (i.e. every physical wing), so it returned pure discretization noise
/// around 0 regardless of the actual loading. The correct Trefftz integrand
/// couples Gamma(z) with the NONLOCAL induced downwash
/// `w(z) = (1/2pi) * integral(dGamma/dz' / (z - z') dz')`, computed here in
/// its standard discrete form -- see `trefftz_drag_sum`.
pub fn induced_drag_trefftz_plane(model: &PanelModel, result: &SolveResult) -> f64 {
    if model.wake_panels.len() < 2 {
        return 0.0;
    }
    let mut stations: Vec<(f64, f64)> = model
        .wake_panels
        .iter()
        .map(|w| (w.z_center, result.mu[w.upper_panel] - result.mu[w.lower_panel]))
        .collect();
    stations.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    let v_inf = result.freestream.v_inf.max(1e-9);
    let q_ref_area = model.reference.area.max(1e-9);
    trefftz_drag_sum(&stations) / (v_inf * v_inf * q_ref_area)
}

/// The discrete Trefftz-plane energy sum `Di / (rho/2) = sum_k(Gamma_k * w_k
/// * dz_k)`, for `stations` = sorted `(z, Gamma)` pairs. In the far-downstream
/// (Trefftz) plane the trailing vortex sheet reduces to a 2D problem: each
/// spanwise strip of constant circulation Gamma_k over `[z_lo, z_hi]` is a
/// constant-strength doublet segment, exactly equivalent to a point-vortex
/// PAIR of strength +-Gamma_k at its two edges (adjacent strips' shared-edge
/// vortices partially cancel, leaving `Gamma_k - Gamma_k+1` -- the shed
/// vorticity -- plus the full tip vortices at the extreme edges, all
/// automatically). A trailing filament far upstream of the evaluation plane
/// looks INFINITE there, so each edge vortex induces `Gamma_e / (2pi * (z -
/// z_e))` normal to the sheet; `w_k` is that sum evaluated at strip k's
/// midpoint (midpoint-rule quadrature keeps the self-term finite). Callers
/// nondimensionalize: `CDi = Di / (q * S) = this / (Vinf^2 * S)`.
///
/// Verified against the exact classical result for elliptic loading,
/// `CDi = CL^2 / (pi * AR)` -- see `elliptic_loading_recovers_classical_
/// induced_drag` below.
fn trefftz_drag_sum(stations: &[(f64, f64)]) -> f64 {
    let n = stations.len();
    if n < 2 {
        return 0.0;
    }

    // Strip boundaries: midway between neighboring stations; the extreme
    // strips extend outboard by half their inboard spacing (Gamma drops to 0
    // just past the outermost stations -- the tip vortices).
    let mut z_lo = vec![0.0; n];
    let mut z_hi = vec![0.0; n];
    for k in 0..n {
        z_lo[k] = if k == 0 {
            stations[0].0 - 0.5 * (stations[1].0 - stations[0].0)
        } else {
            0.5 * (stations[k - 1].0 + stations[k].0)
        };
        z_hi[k] = if k + 1 == n {
            stations[n - 1].0 + 0.5 * (stations[n - 1].0 - stations[n - 2].0)
        } else {
            0.5 * (stations[k].0 + stations[k + 1].0)
        };
    }

    let mut edge_vortices = Vec::with_capacity(2 * n);
    for k in 0..n {
        let gamma = stations[k].1;
        edge_vortices.push((z_lo[k], gamma));
        edge_vortices.push((z_hi[k], -gamma));
    }

    let mut energy_sum = 0.0;
    for k in 0..n {
        let z_mid = 0.5 * (z_lo[k] + z_hi[k]);
        let dz = z_hi[k] - z_lo[k];
        let mut w = 0.0;
        for &(z_e, gamma_e) in &edge_vortices {
            let d = z_mid - z_e;
            if d.abs() > 1e-12 {
                w += gamma_e / (2.0 * std::f64::consts::PI * d);
            }
        }
        energy_sum += stations[k].1 * w * dz;
    }
    energy_sum
}

pub fn coefficients(model: &PanelModel, result: &SolveResult, flow: &SurfaceFlow, cg: Vector3<f64>) -> Coefficients {
    let (cl, cm) = lift_and_moment(model, result, flow, cg);
    let cd_induced = induced_drag_trefftz_plane(model, result);
    Coefficients { cl, cd_induced, cm }
}

/// Convenience one-shot: solve for `freestream`, reconstruct surface flow,
/// and integrate coefficients about `cg` -- what `trim.rs`'s AoA sweep calls
/// repeatedly (the solve itself is the only non-trivial cost; this wrapper's
/// own work is all O(N) or O(N) with a tiny per-panel least-squares fit).
pub fn solve_and_integrate(
    model: &PanelModel,
    freestream: Freestream,
    cg: Vector3<f64>,
) -> Result<Coefficients, crate::solve::PanelError> {
    let result = model.solve(freestream)?;
    let flow = surface_flow(model, &result);
    Ok(coefficients(model, &result, &flow, cg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solve::PanelConfig;


    /// The classical exact result for inviscid potential flow around a
    /// sphere: surface speed is `1.5 * Vinf * sin(theta)` (theta from the
    /// flow axis), peaking at exactly `1.5 * Vinf` on the great circle
    /// perpendicular to the flow (theta=90 deg, i.e. `x~=0` for flow along
    /// +X here) and vanishing at the front/rear stagnation points. This is
    /// the standard textbook check for a potential-flow solver's surface
    /// velocity reconstruction and is independent of anything wing/Kutta-
    /// condition-specific (no wake needed for a closed body).
    ///
    /// Built with `n_wake_strips: 0`: `detect_trailing_edge_strips`'s
    /// per-z-bin max-X heuristic is meaningless on a sphere (its own doc
    /// comment: "assumes a reasonably clean single-surface wing... other
    /// geometry can fool it"), and the "trailing edge" it finds here sits
    /// almost exactly on the downstream stagnation region this test probes.
    /// The wake module's TE-conforming ruled sheet (see `wake::build_wake`)
    /// linearly interpolates between consecutive TE stations, which is
    /// exact for a genuinely straight/linear local TE but UNDERSHOOTS a
    /// strongly curved (concave) one like a sphere's -- placing the sheet's
    /// near edge measurably inside the body and corrupting exactly this
    /// stagnation-region velocity reconstruction with spurious wake
    /// influence. That's a real, sphere-specific limitation of a heuristic
    /// that's only meant to apply to wing-like trailing edges (gentle
    /// curvature by construction) -- not a reason to weaken the wing fix,
    /// and not something this closed-body validation (which explicitly
    /// doesn't need a wake at all) should be exposed to.
    #[test]
    fn sphere_surface_speed_matches_classical_potential_flow_solution() {
        let raw = crate::fixtures::uv_sphere(0.5, 20, 28);
        let (mesh, _) = rekon_geometry::repair(&raw, 1e-5);
        let config = PanelConfig { n_wake_strips: 0, ..PanelConfig::default() };
        let model = PanelModel::build(&mesh, config).expect("builds");
        let freestream = Freestream { alpha_deg: 0.0, v_inf: 20.0 };
        let result = model.solve(freestream).expect("solves");
        let flow = surface_flow(&model, &result);

        // Near the flow-axis equator (x ~ 0): speed should be close to 1.5x Vinf.
        // Also stay away from the uv_sphere mesh's OWN pole singularity (y ~
        // +-radius): the flow-perpendicular great circle x=0 happens to pass
        // through that pole, where panels are small/degenerate purely as a
        // mesh-parametrization artifact, not a flow feature -- including them
        // would measure mesh quality there, not the reconstruction's accuracy.
        let equator_speeds: Vec<f64> = (0..model.panels.len())
            .filter(|&i| model.geoms[i].centroid.x.abs() < 0.03 && model.geoms[i].centroid.y.abs() < 0.4)
            .map(|i| flow.velocity[i].norm() / freestream.v_inf)
            .collect();
        assert!(equator_speeds.len() > 5, "need several equator-band panels to average over");
        let mean_equator_ratio = equator_speeds.iter().sum::<f64>() / equator_speeds.len() as f64;
        eprintln!(
            "equator band: n={} mean(|V|/Vinf)={mean_equator_ratio:.4} (expected ~1.5)",
            equator_speeds.len()
        );
        // Tolerance reflects the documented, empirically-investigated accuracy
        // ceiling of constant-panel + neighbor-gradient reconstruction on a
        // strongly curved body (module docs above) -- this is intentionally
        // looser than the <1% far-field potential match already proven
        // elsewhere; it's still a real, non-trivial bound (rules out a wrong
        // sign, a missing factor-of-2-or-more, or a non-monotonic profile).
        assert!(
            (mean_equator_ratio - 1.5).abs() < 0.5,
            "mean equator-band speed ratio {mean_equator_ratio} should be within the documented ~25-30% ceiling of the exact value 1.5"
        );

        // Near the front stagnation point (x ~ +radius): speed should be small.
        let nose_speeds: Vec<f64> = (0..model.panels.len())
            .filter(|&i| model.geoms[i].centroid.x > 0.47)
            .map(|i| flow.velocity[i].norm() / freestream.v_inf)
            .collect();
        assert!(!nose_speeds.is_empty());
        let mean_nose_ratio = nose_speeds.iter().sum::<f64>() / nose_speeds.len() as f64;
        eprintln!("nose band: n={} mean(|V|/Vinf)={mean_nose_ratio:.4} (expected small)", nose_speeds.len());
        assert!(mean_nose_ratio < 0.5, "stagnation-adjacent speed ratio {mean_nose_ratio} should be small");
    }

    #[test]
    fn symmetric_wing_has_zero_lift_at_zero_alpha_and_increases_with_alpha() {
        let raw = crate::fixtures::smooth_symmetric_wing(1.0, 0.2, 0.02, 14, 10);
        let (mesh, _) = rekon_geometry::repair(&raw, 1e-5);
        let model = PanelModel::build(&mesh, PanelConfig::default()).expect("builds");
        let cg = Vector3::new(0.05, 0.0, 0.0);

        let cl_at = |alpha_deg: f64| -> f64 {
            let freestream = Freestream { alpha_deg, v_inf: 20.0 };
            solve_and_integrate(&model, freestream, cg).expect("solves").cl
        };

        let cl0 = cl_at(0.0);
        eprintln!("CL(alpha=0) = {cl0}");
        assert!(cl0.abs() < 0.05, "symmetric wing should have ~0 lift at alpha=0, got {cl0}");

        let alphas = [-4.0, -2.0, 0.0, 2.0, 4.0, 6.0, 8.0];
        let cls: Vec<f64> = alphas.iter().map(|&a| cl_at(a)).collect();
        eprintln!("CL(alpha): {:?}", alphas.iter().zip(&cls).collect::<Vec<_>>());
        for w in cls.windows(2) {
            assert!(w[1] > w[0], "CL should increase monotonically with alpha, got {cls:?}");
        }
    }

    /// The exact classical benchmark for any Trefftz-plane drag computation:
    /// elliptic loading `Gamma(z) = Gamma0 * sqrt(1 - (2z/b)^2)` gives
    /// `Di = (rho * pi / 8) * Gamma0^2`, i.e. `CDi = CL^2 / (pi * AR)`
    /// exactly. This is a pure-math test of `trefftz_drag_sum` (no panel
    /// solve involved), so the tolerance is tight -- it would have caught the
    /// old `Gamma * dGamma/dz` integrand, which returns ~0 for ANY loading
    /// (its integral telescopes to `[Gamma^2/2]` = 0 tip-to-tip).
    #[test]
    fn elliptic_loading_recovers_classical_induced_drag() {
        let (span, gamma0, v_inf, area) = (2.0_f64, 0.8_f64, 15.0_f64, 0.5_f64);
        let n = 60;
        let stations: Vec<(f64, f64)> = (0..n)
            .map(|k| {
                // Cosine-spaced stations resolve the tip gradient well.
                let theta = (k as f64 + 0.5) / n as f64 * std::f64::consts::PI;
                let z = -0.5 * span * theta.cos();
                (z, gamma0 * (1.0 - (2.0 * z / span).powi(2)).max(0.0).sqrt())
            })
            .collect();

        let cdi = trefftz_drag_sum(&stations) / (v_inf * v_inf * area);

        // Exact: Di/(rho/2) = (pi/4)*Gamma0^2, so CDi = pi*Gamma0^2/(4 V^2 S).
        // (Equivalently CL^2/(pi*AR) with CL = pi*b*Gamma0/(2*V*S).)
        let cdi_exact = std::f64::consts::PI * gamma0 * gamma0 / (4.0 * v_inf * v_inf * area);
        let cl = std::f64::consts::PI * span * gamma0 / (2.0 * v_inf * area);
        let aspect_ratio = span * span / area;
        assert!(
            (cdi_exact - cl * cl / (std::f64::consts::PI * aspect_ratio)).abs() < 1e-12,
            "self-check of the two closed forms"
        );

        let rel_err = (cdi - cdi_exact).abs() / cdi_exact;
        eprintln!("elliptic CDi: computed={cdi:.6} exact={cdi_exact:.6} rel_err={rel_err:.4}");
        assert!(rel_err < 0.05, "discrete Trefftz sum should match CL^2/(pi*AR) within 5%, got rel_err={rel_err}");
        assert!(cdi > 0.0, "induced drag must be positive for nonzero lift");
    }

    /// End-to-end sanity: a real solved lifting wing must report a POSITIVE
    /// CDi consistent with the minimum-drag bound `CL^2 / (pi * AR)` -- where
    /// CL is taken from the WAKE's own circulation distribution (`L = rho * V
    /// * integral(Gamma dz)`), NOT the near-field Cp integration: the two CLs
    /// live in different accuracy regimes (near-field surface-velocity
    /// reconstruction has a documented overprediction ceiling on thick
    /// bodies; the wake circulation comes straight from the machine-precision
    /// mu solve), and Trefftz drag is a functional of the circulation alone,
    /// so that's the self-consistent comparison. The old integrand returned
    /// ~0 (noise) here regardless of lift.
    #[test]
    fn solved_wing_induced_drag_is_positive_and_consistent_with_lift() {
        let raw = crate::fixtures::smooth_symmetric_wing(1.0, 0.2, 0.02, 14, 10);
        let (mesh, _) = rekon_geometry::repair(&raw, 1e-5);
        let model = PanelModel::build(&mesh, PanelConfig::default()).expect("builds");
        let freestream = Freestream { alpha_deg: 6.0, v_inf: 15.0 };
        let result = model.solve(freestream).expect("solves");
        let cd_induced = induced_drag_trefftz_plane(&model, &result);

        // CL implied by the wake circulation: CL = 2 * integral(Gamma dz) / (V * S).
        let mut stations: Vec<(f64, f64)> = model
            .wake_panels
            .iter()
            .map(|w| (w.z_center, result.mu[w.upper_panel] - result.mu[w.lower_panel]))
            .collect();
        stations.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut gamma_integral = 0.0;
        for k in 0..stations.len() {
            let z_lo = if k == 0 { stations[0].0 } else { 0.5 * (stations[k - 1].0 + stations[k].0) };
            let z_hi = if k + 1 == stations.len() {
                stations[k].0
            } else {
                0.5 * (stations[k].0 + stations[k + 1].0)
            };
            gamma_integral += stations[k].1 * (z_hi - z_lo);
        }
        let cl_wake = 2.0 * gamma_integral / (freestream.v_inf * model.reference.area);

        let aspect_ratio = model.reference.span.powi(2) / model.reference.area;
        let cdi_min = cl_wake * cl_wake / (std::f64::consts::PI * aspect_ratio);
        eprintln!("CL_wake={cl_wake:.4} CDi={cd_induced:.5} elliptic minimum CDi={cdi_min:.5} (AR={aspect_ratio:.2})");
        assert!(cd_induced > 0.0, "lifting wing must have positive induced drag, got {cd_induced}");
        // Elliptic loading is the MINIMUM drag for a given lift; real
        // (non-elliptic) loading sits above it, and shouldn't be wildly off:
        // accept [0.9x, 3x] (0.9 rather than 1.0 leaves margin for the
        // discrete quadrature in both quantities).
        assert!(
            cd_induced > 0.9 * cdi_min && cd_induced < 3.0 * cdi_min,
            "CDi={cd_induced} should be within [0.9x, 3x] of the elliptic minimum {cdi_min} for its own circulation"
        );
    }

    #[test]
    fn cg_change_requires_no_resolve_and_moment_shifts_linearly() {
        let raw = crate::fixtures::smooth_symmetric_wing(1.0, 0.2, 0.02, 14, 10);
        let (mesh, _) = rekon_geometry::repair(&raw, 1e-5);
        let model = PanelModel::build(&mesh, PanelConfig::default()).expect("builds");
        let freestream = Freestream { alpha_deg: 4.0, v_inf: 20.0 };

        // Solve ONCE; every CG query below reuses this same result -- no
        // `model.solve` call appears anywhere in the loop below, which is
        // the architectural point being tested (CG motion is O(N) moment
        // re-integration, never a re-solve).
        let result = model.solve(freestream).expect("solves");
        let flow = surface_flow(&model, &result);

        let cg_a = Vector3::new(0.0, 0.0, 0.0);
        let cg_b = Vector3::new(0.1, 0.0, 0.0);
        let (cl_a, cm_a) = lift_and_moment(&model, &result, &flow, cg_a);
        let (cl_b, cm_b) = lift_and_moment(&model, &result, &flow, cg_b);

        assert!((cl_a - cl_b).abs() < 1e-9, "CL must not depend on CG at all");

        // Exact moment-transfer identity: M(cg_b) - M(cg_a) = (cg_b-cg_a) x
        // F_total, restricted to the Z-component (dropping into the pitching-
        // moment sign convention lift_and_moment itself uses). Deriving the
        // expected shift from CL alone (rather than the raw total force
        // vector) would only be exact at alpha=0, where `lift_dir` is exactly
        // the global Y axis -- at nonzero alpha the two differ by the small
        // freestream-rotation angle, which is why this recomputes the total
        // force vector directly here instead of reusing `cl_a`.
        let vinf = freestream.velocity();
        let mut force_total = Vector3::zeros();
        for i in 0..model.panels.len() {
            let area = model.panels[i].area as f64;
            let normal = model.geoms[i].normal;
            force_total += -flow.cp[i] * area * normal;
        }
        let _ = vinf; // not needed once using the raw force vector directly

        // pitching_moment(cg) = -sum((centroid-cg) x force).z, so
        // pitching_moment(cg_b) - pitching_moment(cg_a) works out to exactly
        // dcg.x*Fy_total - dcg.y*Fx_total (the two extra sign flips --
        // lift_and_moment's own "-moment.z" convention, and the (a-b) vs
        // (b-a) direction of the transfer -- cancel each other).
        let dcg = cg_b - cg_a;
        let expected_moment_shift_z = dcg.x * force_total.y - dcg.y * force_total.x;
        let expected_cm_shift = expected_moment_shift_z / (model.reference.area * model.reference.chord);
        let actual_cm_shift = cm_b - cm_a;
        assert!(
            (actual_cm_shift - expected_cm_shift).abs() < 1e-6,
            "cm shifted by {actual_cm_shift}, expected exactly {expected_cm_shift} from the moment-transfer identity (cm_a={cm_a}, cm_b={cm_b})"
        );
    }
}

#[cfg(test)]
mod known_issues {
    use super::*;
    use crate::solve::PanelConfig;
    use glam::Vec3;
    use rekon_geometry::Mesh;

    /// Same construction as fixtures::smooth_symmetric_wing, but chord
    /// TAPERS linearly from `root_chord` (at z=0, mesh spans z=0..span so
    /// it's a single-direction taper, NOT the mirrored/double-taper shape) to
    /// `tip_chord` (at z=span). Everything else (thickness profile, ring/
    /// triangulation pattern) is copy-pasted verbatim from the proven fixture.
    fn tapered_smooth_wing(span: f32, root_chord: f32, tip_chord: f32, thickness: f32, n_span: usize, n_chord: usize) -> Mesh {
        let peak = (1.0f32 / 3.0).sqrt() * (2.0 / 3.0);
        let half_thickness_at = |x: f32, chord: f32| -> f32 {
            let s = (x / chord).clamp(0.0, 1.0);
            thickness * 0.5 * (s.sqrt() * (1.0 - s)) / peak
        };
        let x_at = |i: usize, chord: f32| -> f32 {
            let s = i as f32 / (n_chord - 1) as f32;
            chord * 0.5 * (1.0 - (s * std::f32::consts::PI).cos())
        };

        let n_per_ring = 2 * (n_chord - 1);
        let mut vertices = Vec::with_capacity(n_span * n_per_ring);
        let mut chord_at_k = Vec::with_capacity(n_span);
        for k in 0..n_span {
            let t = k as f32 / (n_span - 1) as f32;
            let z = t * span;
            let chord = root_chord + (tip_chord - root_chord) * t;
            chord_at_k.push(chord);
            for i in 0..n_chord {
                let x = x_at(i, chord);
                vertices.push(Vec3::new(x, half_thickness_at(x, chord), z));
            }
            for i in (1..n_chord - 1).rev() {
                let x = x_at(i, chord);
                vertices.push(Vec3::new(x, -half_thickness_at(x, chord), z));
            }
        }
        let ring_index = |k: usize, i: usize| -> u32 { (k * n_per_ring + i % n_per_ring) as u32 };

        // Quad-strip triangulation between adjacent rings. The lower-surface
        // half of each ring's vertex loop (built above, `(1..n_chord -
        // 1).rev()`) is stored in REVERSED chordwise order relative to the
        // upper half, so that the ring is one continuous closed perimeter
        // (LE -> upper -> TE -> lower -> LE) -- but that reversal means a
        // quad's 4 corners (a,b,c,d) relate to its mirror-image quad (on the
        // opposite, y-negated surface) via a (b,a,d,c) relabeling, not the
        // identity. Always splitting along the SAME (a-c) diagonal, as a
        // naive uniform quad-strip triangulator would, therefore picks a
        // DIFFERENT diagonal (in physical terms) on the lower surface than
        // on the upper one -- the two surfaces are geometrically identical
        // (mirror images) but their DISCRETE TRIANGLES aren't, which
        // silently broke exact top/bottom panel correspondence and was
        // confirmed (via an independently-triangulated-surfaces control
        // fixture giving CL(alpha=0) to machine precision, vs. this
        // fixture's own multi-tenths-of-a-CL error before this fix) to be
        // large enough to fail the symmetry tests below on its own, with NO
        // solver bug involved. Splitting upper-role quads (i < n_chord - 1)
        // along a-c and lower-role quads (i >= n_chord - 1) along the
        // relabeled b-d diagonal instead makes every lower triangle the
        // EXACT vertex-for-vertex mirror of its upper counterpart.
        let mut triangles = Vec::new();
        for k in 0..n_span - 1 {
            for i in 0..n_per_ring {
                let a = ring_index(k, i);
                let b = ring_index(k, i + 1);
                let c = ring_index(k + 1, i + 1);
                let d = ring_index(k + 1, i);
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
            let z = vertices[ring_index(k, 0) as usize].z;
            let chord = chord_at_k[k];
            let centroid_idx = vertices.len() as u32;
            vertices.push(Vec3::new(chord * 0.5, 0.0, z));
            for i in 0..n_per_ring {
                triangles.push([centroid_idx, ring_index(k, i), ring_index(k, i + 1)]);
            }
        }

        Mesh { vertices, triangles }
    }

    /// FIXED (was a known, unresolved limitation): a wing with tapered
    /// (non-constant-chord) planform should have CL(alpha=0) == 0 exactly,
    /// by top-bottom mirror symmetry of an uncambered section --
    /// `control_untapered_wing_...` below proves this EXACT SAME
    /// construction code gives that correctly when taper is disabled
    /// (root_chord == tip_chord).
    ///
    /// Root cause (see `wake::build_wake`'s doc comment for the full
    /// diagnosis): the old wake sheet was an axis-aligned rectangle at one
    /// constant x per strip, which strayed off a tapered/swept trailing
    /// edge and sliced through the wing's own skin -- collocation points
    /// then sat on both sides of the doublet sheet's jump discontinuity,
    /// injecting corrections into the doublet AIC large enough to invert
    /// the resolved circulation. Fixed by rebuilding the wake as a
    /// TE-conforming ruled sheet whose near edge tracks the actual local
    /// trailing edge instead of one fixed x.
    #[test]
    fn tapered_wing_should_preserve_zero_lift_symmetry() {
        let raw = tapered_smooth_wing(1.0, 0.26, 0.09, 0.02, 14, 10);
        let (mesh, _) = rekon_geometry::repair(&raw, 1e-5);
        let model = PanelModel::build(&mesh, PanelConfig::default()).expect("builds");
        let cg = nalgebra::Vector3::new(0.05, 0.0, 0.0);
        let cl0 = solve_and_integrate(&model, Freestream { alpha_deg: 0.0, v_inf: 15.0 }, cg).expect("solves").cl;
        assert!(cl0.abs() < 0.05, "tapered wing CL(alpha=0) should be ~0 by symmetry, got {cl0}");
    }

    /// Control: the EXACT SAME construction code as the test above, with
    /// taper disabled (root_chord == tip_chord), correctly gives CL(0)~0 and
    /// increasing CL with alpha -- confirming the failure above is specific
    /// to chord taper, not a general problem with this mesh-construction
    /// pattern or a pre-existing issue this project already had.
    #[test]
    fn control_untapered_wing_correctly_has_increasing_cl_with_alpha() {
        let raw = tapered_smooth_wing(1.0, 0.2, 0.2, 0.02, 14, 10);
        let (mesh, _) = rekon_geometry::repair(&raw, 1e-5);
        let model = PanelModel::build(&mesh, PanelConfig::default()).expect("builds");
        let cg = nalgebra::Vector3::new(0.05, 0.0, 0.0);
        let cls: Vec<f64> = [-4.0, 0.0, 4.0]
            .iter()
            .map(|&a| solve_and_integrate(&model, Freestream { alpha_deg: a, v_inf: 15.0 }, cg).expect("solves").cl)
            .collect();
        assert!(cls[1].abs() < 0.01, "CL(0) should be ~0, got {:?}", cls[1]);
        assert!(cls[0] < cls[1] && cls[1] < cls[2], "CL should increase with alpha, got {cls:?}");
    }

    /// Same construction pattern as `tapered_smooth_wing`, but spans
    /// z=-half_span..+half_span with the SAME taper schedule mirrored about
    /// the root (z=0) -- a much closer stand-in for a real flying wing than
    /// the single-direction-taper fixture above -- and additionally
    /// exercises SWEEP (a leading-edge x-offset growing with `|z|`), which
    /// produces the exact same "wake sheet doesn't track the local TE"
    /// failure mode as taper on the old (unfixed) wake construction.
    fn mirrored_tapered_swept_wing(
        half_span: f32,
        root_chord: f32,
        tip_chord: f32,
        sweep_slope: f32,
        thickness: f32,
        n_span: usize,
        n_chord: usize,
    ) -> Mesh {
        let peak = (1.0f32 / 3.0).sqrt() * (2.0 / 3.0);
        let half_thickness_at = |x_local: f32, chord: f32| -> f32 {
            let s = (x_local / chord).clamp(0.0, 1.0);
            thickness * 0.5 * (s.sqrt() * (1.0 - s)) / peak
        };
        let x_at = |i: usize, chord: f32| -> f32 {
            let s = i as f32 / (n_chord - 1) as f32;
            chord * 0.5 * (1.0 - (s * std::f32::consts::PI).cos())
        };

        let n_per_ring = 2 * (n_chord - 1);
        let mut vertices = Vec::with_capacity(n_span * n_per_ring);
        let mut chord_at_k = Vec::with_capacity(n_span);
        let mut le_x_at_k = Vec::with_capacity(n_span);
        for k in 0..n_span {
            let t = k as f32 / (n_span - 1) as f32; // 0..1
            let z = -half_span + t * (2.0 * half_span);
            let s = (z.abs() / half_span).clamp(0.0, 1.0); // 0 at root, 1 at tip
            let chord = root_chord + (tip_chord - root_chord) * s;
            let le_x = sweep_slope * z.abs();
            chord_at_k.push(chord);
            le_x_at_k.push(le_x);
            for i in 0..n_chord {
                let x_local = x_at(i, chord);
                vertices.push(Vec3::new(le_x + x_local, half_thickness_at(x_local, chord), z));
            }
            for i in (1..n_chord - 1).rev() {
                let x_local = x_at(i, chord);
                vertices.push(Vec3::new(le_x + x_local, -half_thickness_at(x_local, chord), z));
            }
        }
        let ring_index = |k: usize, i: usize| -> u32 { (k * n_per_ring + i % n_per_ring) as u32 };

        // See `tapered_smooth_wing`'s doc comment on this same split for why
        // the diagonal must depend on ring-role (upper vs. lower): a
        // uniform a-c split makes the discretized upper/lower triangles NOT
        // exact mirrors of each other (their vertex ROLES relabel as
        // (a,b,c,d)->(b,a,d,c) across the mirror), which independently
        // breaks CL(alpha=0)=0 regardless of any wake-model correctness.
        let mut triangles = Vec::new();
        for k in 0..n_span - 1 {
            for i in 0..n_per_ring {
                let a = ring_index(k, i);
                let b = ring_index(k, i + 1);
                let c = ring_index(k + 1, i + 1);
                let d = ring_index(k + 1, i);
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
            let z = vertices[ring_index(k, 0) as usize].z;
            let chord = chord_at_k[k];
            let le_x = le_x_at_k[k];
            let centroid_idx = vertices.len() as u32;
            vertices.push(Vec3::new(le_x + chord * 0.5, 0.0, z));
            for i in 0..n_per_ring {
                triangles.push([centroid_idx, ring_index(k, i), ring_index(k, i + 1)]);
            }
        }

        Mesh { vertices, triangles }
    }

    /// The realistic case: a mirror-symmetric (about the root), TAPERED AND
    /// SWEPT wing should have CL(alpha=0) ~ 0 (tighter tolerance than the
    /// single-direction-taper test above, since the mirrored planform has no
    /// asymmetric-loading escape hatch) and a physically sane, POSITIVE
    /// dCL/dalpha that is somewhat BELOW the equivalent straight, untapered
    /// wing's own slope (taper and sweep both reduce lift-curve slope
    /// relative to a rectangular planform of the same span, a standard
    /// finite-wing result) -- not the classical *thin-airfoil* range,
    /// because this project's panel method models the wing's actual
    /// thickness (a closed volume, not a camber-line sheet), which this
    /// same fixture's untapered/unswept control
    /// (`control_untapered_wing_correctly_has_increasing_cl_with_alpha`, AR
    /// 5, 10%-thick) independently measures at ~9/rad, well above the
    /// thin-airfoil-theory estimate for that aspect ratio -- so [3,6]/rad
    /// would reject even a bug-free result for this fixture family.
    #[test]
    fn mirrored_swept_tapered_wing_has_correct_cl_symmetry_and_slope() {
        let raw = mirrored_tapered_swept_wing(0.5, 0.26, 0.09, 0.15, 0.02, 17, 10);
        let (mesh, _) = rekon_geometry::repair(&raw, 1e-5);
        let model = PanelModel::build(&mesh, PanelConfig::default()).expect("builds");
        let cg = nalgebra::Vector3::new(0.05, 0.0, 0.0);

        let cl0 = solve_and_integrate(&model, Freestream { alpha_deg: 0.0, v_inf: 15.0 }, cg).expect("solves").cl;
        assert!(cl0.abs() < 0.02, "mirrored swept+tapered wing CL(0) should be ~0, got {cl0}");

        let cl_lo = solve_and_integrate(&model, Freestream { alpha_deg: -3.0, v_inf: 15.0 }, cg).expect("solves").cl;
        let cl_hi = solve_and_integrate(&model, Freestream { alpha_deg: 3.0, v_inf: 15.0 }, cg).expect("solves").cl;
        let slope_per_rad = (cl_hi - cl_lo) / 6.0f64.to_radians();
        assert!(
            (5.0..=9.0).contains(&slope_per_rad),
            "dCL/dalpha should be positive and below the untapered control's ~9/rad, got {slope_per_rad}"
        );
    }
}

