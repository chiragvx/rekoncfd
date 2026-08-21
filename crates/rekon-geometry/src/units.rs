use crate::mesh::Aabb;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    Meters,
    Millimeters,
    Inches,
    /// Override-only: NOT part of `guess_unit`'s heuristic chain (a raw
    /// extent that's plausible in cm is ALSO plausible in inches, so adding
    /// it there would only make the guess more ambiguous, not more useful) --
    /// available so a user can explicitly select it after import.
    Centimeters,
}

impl Unit {
    pub fn to_meters_scale(self) -> f32 {
        match self {
            Unit::Meters => 1.0,
            Unit::Millimeters => 0.001,
            Unit::Inches => 0.0254,
            Unit::Centimeters => 0.01,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct UnitGuess {
    pub unit: Unit,
    /// Not a statistical confidence — a coarse "how far from the expected RC-wing
    /// size band" signal so the caller can decide whether to warn the user.
    pub confident: bool,
}

/// STL carries no unit metadata, so this is a heuristic based on the assumption
/// that the model is an RC flying wing with a largest bounding-box dimension
/// somewhere in the 0.2m-3m range. A wrong guess here silently invalidates every
/// Reynolds-number-dependent calculation downstream, so the caller MUST surface
/// this guess and a manual override in the UI rather than trusting it silently.
pub fn guess_unit(bbox: &Aabb) -> UnitGuess {
    let max_extent = bbox.size().max_element();

    // Plausible span if interpreted at each candidate unit scale.
    let as_meters = max_extent;
    let as_millimeters = max_extent * Unit::Millimeters.to_meters_scale();
    let as_inches = max_extent * Unit::Inches.to_meters_scale();

    const PLAUSIBLE: std::ops::Range<f32> = 0.2..3.0;

    if PLAUSIBLE.contains(&as_meters) {
        UnitGuess { unit: Unit::Meters, confident: true }
    } else if PLAUSIBLE.contains(&as_millimeters) {
        UnitGuess { unit: Unit::Millimeters, confident: true }
    } else if PLAUSIBLE.contains(&as_inches) {
        UnitGuess { unit: Unit::Inches, confident: true }
    } else {
        // Nothing landed in the plausible band — default to millimeters (the most
        // common CAD-export unit) but flag it as a low-confidence guess.
        UnitGuess { unit: Unit::Millimeters, confident: false }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    fn bbox_with_max_extent(extent: f32) -> Aabb {
        Aabb { min: Vec3::ZERO, max: Vec3::new(extent, extent * 0.2, extent * 0.05) }
    }

    #[test]
    fn detects_meters_for_typical_wing_span() {
        let guess = guess_unit(&bbox_with_max_extent(1.2));
        assert_eq!(guess.unit, Unit::Meters);
        assert!(guess.confident);
    }

    #[test]
    fn detects_millimeters_for_large_raw_numbers() {
        let guess = guess_unit(&bbox_with_max_extent(1200.0));
        assert_eq!(guess.unit, Unit::Millimeters);
        assert!(guess.confident);
    }
}
