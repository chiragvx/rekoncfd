use rekon_geometry::{Airfoil, WingParams};

/// One entry in the "Explore Models" catalog. Every entry today is
/// procedurally generated (via `rekon_geometry::naca`) rather than a real
/// uploaded aircraft -- honestly labeled as such in `description` -- so the
/// gallery is fully functional today and ready to grow real user-supplied
/// STL models alongside these later without any API shape changes.
pub struct SampleModel {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub tags: &'static [&'static str],
    pub params: WingParams,
}

pub fn catalog() -> Vec<SampleModel> {
    vec![
        SampleModel {
            id: "symmetric-flying-wing",
            name: "Symmetric Flying Wing",
            description: "Procedural demo: NACA 0012, untapered, moderate sweep — a simple baseline flying-wing planform.",
            tags: &["procedural", "symmetric", "beginner"],
            params: WingParams {
                airfoil: Airfoil::parse_naca("0012").expect("valid designation"),
                span_m: 1.2,
                root_chord_m: 0.28,
                tip_chord_m: 0.28,
                sweep_deg: 12.0,
                dihedral_deg: 2.0,
                washout_deg: -2.0,
                n_chord_stations: 18,
                n_span_stations: 14,
            },
        },
        SampleModel {
            id: "tapered-swept-wing",
            name: "Tapered Swept Wing",
            description: "Procedural demo: NACA 2412, tapered + swept planform with washout — a more representative RC flying-wing shape.",
            tags: &["procedural", "cambered", "tapered"],
            params: WingParams {
                airfoil: Airfoil::parse_naca("2412").expect("valid designation"),
                span_m: 1.4,
                root_chord_m: 0.32,
                tip_chord_m: 0.12,
                sweep_deg: 22.0,
                dihedral_deg: 3.0,
                washout_deg: -4.0,
                n_chord_stations: 18,
                n_span_stations: 14,
            },
        },
        SampleModel {
            id: "high-camber-glider",
            name: "High-Camber Glider Wing",
            description: "Procedural demo: NACA 23012, mild taper, low sweep — tuned for gentle glide rather than speed.",
            tags: &["procedural", "cambered", "glider"],
            params: WingParams {
                airfoil: Airfoil::parse_naca("23012").expect("valid designation"),
                span_m: 1.6,
                root_chord_m: 0.24,
                tip_chord_m: 0.16,
                sweep_deg: 8.0,
                dihedral_deg: 4.0,
                washout_deg: -3.0,
                n_chord_stations: 18,
                n_span_stations: 14,
            },
        },
    ]
}

pub fn find(id: &str) -> Option<SampleModel> {
    catalog().into_iter().find(|m| m.id == id)
}
