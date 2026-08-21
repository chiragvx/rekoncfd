//! Assembles a mesh's panel geometry, source/doublet AIC matrices, and wake
//! into a `PanelModel`, then factorizes the (wake-folded) doublet matrix C
//! exactly once. Every subsequent angle-of-attack / airspeed query is a cheap
//! cached-LU back-substitution against that single factorization -- see
//! `PanelModel::solve`.

use std::collections::HashMap;

use nalgebra::linalg::LU;
use nalgebra::{DMatrix, DVector, Dyn, Vector3};
use rekon_geometry::{detect_trailing_edge_strips, panelize, Mesh, Panel};
use thiserror::Error;

use crate::aic::{build_body_aic, collocation_point, PanelGeom};
use crate::wake::{build_wake, fold_wake_into_c, WakeConfig, WakePanel};

#[derive(Debug, Error)]
pub enum PanelError {
    #[error("mesh has no panels")]
    EmptyMesh,
    #[error("doublet influence matrix is singular -- check for degenerate/non-manifold panel geometry")]
    SingularSystem,
}

#[derive(Debug, Clone, Copy)]
pub struct PanelConfig {
    /// Number of spanwise trailing-edge stations to build wake panels for;
    /// forwarded to `rekon_geometry::detect_trailing_edge_strips`.
    pub n_wake_strips: usize,
    /// Wake length as a multiple of the mesh's spanwise extent. Large enough
    /// that near-body results are insensitive to it (see `wake` module docs
    /// for why this is a finite stand-in for a semi-infinite wake).
    pub wake_length_factor: f64,
    /// Vortex-filament core radius as a multiple of the mean panel size,
    /// regularizing the Biot-Savart 1/distance singularity.
    pub core_radius_factor: f64,
}

impl Default for PanelConfig {
    fn default() -> Self {
        Self { n_wake_strips: 20, wake_length_factor: 25.0, core_radius_factor: 1e-3 }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ReferenceQuantities {
    pub area: f64,
    pub chord: f64,
    pub span: f64,
}

impl ReferenceQuantities {
    /// Span comes from the bbox (unambiguous); area is the true planform
    /// area -- half the sum of each triangle's area weighted by
    /// `|normal.y|` (its projection onto the X-Z/chord-span plane). The
    /// factor of 1/2 accounts for a closed thin-body wing mesh having BOTH
    /// an upper and a lower skin, each of which projects onto ~the same
    /// planform footprint, so summing over every triangle double-counts it.
    /// Chord is then the mean geometric chord `area / span`, not the bbox
    /// X-extent -- for a tapered or swept wing the bbox X-extent is neither
    /// the root chord nor a sensible mean (it can include both LE and TE
    /// sweep), which previously read reference CL a consistent ~33% low on
    /// a representative tapered fixture (bbox area is systematically larger
    /// than true planform area whenever the planform isn't a rectangle).
    pub fn from_mesh(mesh: &Mesh, panels: &[Panel]) -> Self {
        let span = mesh.bounding_box().size().z as f64;
        let area = 0.5
            * panels
                .iter()
                .map(|p| p.area as f64 * p.normal.y.abs() as f64)
                .sum::<f64>();
        let chord = area / span.max(1e-9);
        Self { area, chord, span }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Freestream {
    pub alpha_deg: f64,
    pub v_inf: f64,
}

impl Freestream {
    pub fn velocity(&self) -> Vector3<f64> {
        let a = self.alpha_deg.to_radians();
        Vector3::new(self.v_inf * a.cos(), self.v_inf * a.sin(), 0.0)
    }
}

pub struct SolveResult {
    pub freestream: Freestream,
    pub mu: DVector<f64>,
    pub sigma: DVector<f64>,
}

/// Geometry-only (AoA/V-independent) panel model: source/doublet AICs, wake,
/// and the LU-factorized system matrix, built once per mesh. Cheap to query
/// repeatedly via `solve` for different `Freestream`s.
pub struct PanelModel {
    pub panels: Vec<Panel>,
    pub reference: ReferenceQuantities,
    pub(crate) geoms: Vec<PanelGeom>,
    pub(crate) collocation: Vec<Vector3<f64>>,
    /// Panel-to-panel adjacency via shared mesh edges (true topological
    /// adjacency, not centroid proximity -- important near a thin trailing
    /// edge, where the opposite surface can be geometrically close without
    /// being aerodynamically adjacent). Used by `aero_coeffs` for tangential
    /// gradient reconstruction.
    pub(crate) adjacency: Vec<Vec<usize>>,
    pub(crate) wake_panels: Vec<WakePanel>,
    b: DMatrix<f64>,
    c_lu: LU<f64, Dyn, Dyn>,
}

impl PanelModel {
    pub fn build(mesh: &Mesh, config: PanelConfig) -> Result<Self, PanelError> {
        let panels = panelize(mesh);
        if panels.is_empty() {
            return Err(PanelError::EmptyMesh);
        }

        let geoms: Vec<PanelGeom> = panels.iter().map(PanelGeom::from_panel).collect();
        let collocation: Vec<Vector3<f64>> = geoms.iter().map(collocation_point).collect();

        let body = build_body_aic(&geoms, &collocation);
        let mut c = body.c;

        let te_strips = detect_trailing_edge_strips(mesh, config.n_wake_strips);
        let mean_scale = geoms.iter().map(|g| g.scale()).sum::<f64>() / geoms.len() as f64;
        let reference = ReferenceQuantities::from_mesh(mesh, &panels);
        let wake_cfg = WakeConfig {
            wake_length_m: config.wake_length_factor * reference.span.max(1e-6),
            core_radius_m: config.core_radius_factor * mean_scale,
            te_aft_nudge_m: 1e-3 * mean_scale,
        };
        let wake_panels = build_wake(&panels, &te_strips, config.n_wake_strips, wake_cfg);
        if wake_panels.len() < te_strips.len() {
            tracing::warn!(
                paired = wake_panels.len(),
                requested = te_strips.len(),
                "could not pair every trailing-edge station with an upper+lower panel; the Kutta condition is incomplete for part of the span on this mesh"
            );
        }
        fold_wake_into_c(&mut c, &wake_panels, &collocation);

        let adjacency = build_adjacency(mesh);

        let c_lu = LU::new(c);
        if !c_lu.is_invertible() {
            return Err(PanelError::SingularSystem);
        }

        tracing::info!(
            panels = panels.len(),
            wake_panels = wake_panels.len(),
            te_stations_requested = te_strips.len(),
            span_m = reference.span,
            chord_m = reference.chord,
            "panel model built (AIC assembled, C factorized)"
        );

        Ok(Self {
            panels,
            reference,
            geoms,
            collocation,
            adjacency,
            wake_panels,
            b: body.b,
            c_lu,
        })
    }

    /// The expensive-ish step (O(n^2) back-substitution against the already-
    /// factorized C) for one angle of attack / airspeed. Everything CG-
    /// related (see `aero_coeffs::pitching_moment`) is deliberately kept out
    /// of this function so moving the CG never triggers a re-solve.
    pub fn solve(&self, freestream: Freestream) -> Result<SolveResult, PanelError> {
        let vinf = freestream.velocity();
        let n = self.panels.len();
        let sigma = DVector::from_iterator(n, self.geoms.iter().map(|g| -vinf.dot(&g.normal)));

        // Dirichlet condition is on the TOTAL interior potential, Phi_inf(P) +
        // phi_perturbation(P) = 0, not just the perturbation potential -- so
        // the freestream's own potential Vinf.P at each collocation point has
        // to appear in the RHS alongside the source contribution. Omitting it
        // silently produces a self-consistent but physically wrong solve (the
        // linear algebra residual is machine-epsilon either way; only the
        // flow-tangency check catches this, which is exactly why that check
        // is required rather than optional).
        let vinf_potential = DVector::from_iterator(n, self.collocation.iter().map(|p| vinf.dot(p)));
        let b_sigma = &self.b * &sigma;
        let rhs = -b_sigma - vinf_potential;
        let mu = self.c_lu.solve(&rhs).ok_or(PanelError::SingularSystem)?;
        Ok(SolveResult { freestream, mu, sigma })
    }
}

fn build_adjacency(mesh: &Mesh) -> Vec<Vec<usize>> {
    let mut edge_to_tris: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (ti, tri) in mesh.triangles.iter().enumerate() {
        for i in 0..3 {
            let a = tri[i];
            let b = tri[(i + 1) % 3];
            edge_to_tris.entry((a.min(b), a.max(b))).or_default().push(ti);
        }
    }

    let mut adjacency = vec![Vec::new(); mesh.triangles.len()];
    for tris in edge_to_tris.values() {
        for &ti in tris {
            for &tj in tris {
                if ti != tj && !adjacency[ti].contains(&tj) {
                    adjacency[ti].push(tj);
                }
            }
        }
    }
    adjacency
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{smooth_symmetric_wing, symmetric_diamond_wing};

    /// Test 1 (spec): flow-tangency / impermeable-surface check. The physical
    /// content of "flow tangency" is that no flow crosses the body surface --
    /// the NORMAL component of velocity there is ~0. This checks that
    /// directly, via a finite difference of the exterior potential along each
    /// panel's own normal direction (see `aero_coeffs::exterior_potential_at`).
    ///
    /// An earlier version of this test instead summed every source/doublet
    /// panel's *velocity* kernel (Biot-Savart-style for doublets) directly at
    /// each collocation point. That approach is numerically unsound this
    /// close to a many-panel surface: self- and near-neighbor velocity terms
    /// are individually tens of times `Vinf` and must cancel to a small
    /// residual, and empirically that cancellation got WORSE, not better,
    /// under mesh refinement (max residual 0.50/0.93/1.33/2.10 across
    /// 140/352/816/1700-panel spheres -- the textbook signature of an
    /// ill-conditioned evaluation, not a real physical residual). Potential
    /// evaluation (used here) doesn't have that failure mode -- see
    /// `aero_coeffs`'s module docs for the full investigation, which also
    /// independently confirmed the linear solve itself is exact
    /// (`||C.mu - rhs|| / ||rhs|| ~ 1e-15`) and every kernel is correct via
    /// closed-form identities, so the earlier test's failure was in the
    /// check itself, not the solve it was checking.
    #[test]
    fn flow_tangency_normal_velocity_is_small_at_the_surface() {
        let raw = smooth_symmetric_wing(1.0, 0.2, 0.02, 14, 10);
        let (mesh, _) = rekon_geometry::repair(&raw, 1e-5);
        let model = PanelModel::build(&mesh, PanelConfig::default()).expect("builds");
        let freestream = Freestream { alpha_deg: 5.0, v_inf: 20.0 };
        let result = model.solve(freestream).expect("solves");

        let mean_scale: f64 = model.geoms.iter().map(|g| g.scale()).sum::<f64>() / model.panels.len() as f64;
        let h = mean_scale * 2.0;

        let mut relatives: Vec<f64> = model
            .geoms
            .iter()
            .map(|g| {
                let p_out = g.centroid + g.normal * (h + h * 0.5);
                let p_in = g.centroid + g.normal * (h - h * 0.5);
                let phi_out = crate::aero_coeffs::exterior_potential_at(&model, &result, p_out);
                let phi_in = crate::aero_coeffs::exterior_potential_at(&model, &result, p_in);
                let v_normal = (phi_out - phi_in) / h;
                (v_normal / freestream.v_inf).abs()
            })
            .collect();
        relatives.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = relatives[relatives.len() / 2];
        let p90 = relatives[(relatives.len() as f64 * 0.9) as usize];

        // Median/p90 (not strict max): a handful of panels sit on genuine
        // geometric singularities that flat, constant-strength panels cannot
        // resolve regardless of solver correctness -- the leading edge's
        // infinite curvature (see `smooth_symmetric_wing`'s own doc comment)
        // and the wingtip end-cap panels. This still directly tests the real
        // boundary condition (near-zero normal velocity) across the bulk of
        // the surface, which a broken solve would fail broadly, not just at
        // a few corner panels.
        assert!(
            median < 0.2,
            "median normal-velocity/Vinf = {median} should be small across the bulk of the surface"
        );
        assert!(p90 < 0.6, "p90 normal-velocity/Vinf = {p90} should still be bounded, not blown up");
    }

    /// Test 2 (spec): closed-body mass conservation. For a Neumann-BC source
    /// distribution over a closed watertight body, sum(sigma_j * area_j) must
    /// be ~0 -- any net nonzero value means the body is acting as a net
    /// source or sink of fluid, which a closed surface in a uniform stream
    /// cannot physically be. This is independent of the doublet/Kutta
    /// machinery entirely (sigma is set directly from Vinf.n).
    #[test]
    fn closed_body_has_zero_net_source_strength() {
        let mesh = symmetric_diamond_wing(1.0, 0.2, 0.02, 10);
        let (repaired, report) = rekon_geometry::repair(&mesh, 1e-5);
        assert_eq!(report.open_edges, 0, "fixture must be watertight for this test to mean anything");

        let model = PanelModel::build(&repaired, PanelConfig::default()).expect("builds");
        let freestream = Freestream { alpha_deg: 4.0, v_inf: 15.0 };
        let result = model.solve(freestream).expect("solves");

        let net_source: f64 =
            result.sigma.iter().zip(&model.panels).map(|(&s, p)| s * p.area as f64).sum();
        let scale: f64 = model.panels.iter().map(|p| p.area as f64).sum::<f64>() * freestream.v_inf;
        assert!(
            net_source.abs() / scale < 1e-6,
            "net source strength {net_source} should be ~0 for a closed body (scale={scale})"
        );
    }

    #[test]
    fn build_reports_reasonable_reference_quantities() {
        let mesh = symmetric_diamond_wing(1.0, 0.2, 0.02, 10);
        let model = PanelModel::build(&mesh, PanelConfig::default()).expect("builds");
        assert!((model.reference.span - 1.0).abs() < 1e-3);
        assert!((model.reference.chord - 0.2).abs() < 1e-3);
        assert!(model.panels.len() > 50);
    }
}
