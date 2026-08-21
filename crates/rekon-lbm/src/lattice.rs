use std::sync::OnceLock;

use glam::Vec3;
use rayon::prelude::*;

/// D3Q19: rest particle + 6 face neighbors + 12 edge neighbors, indices fixed
/// by this array — every other lookup table in this module (`opposite`,
/// `mirror_y`, `mirror_z`) is derived from it, never hand-transcribed, so a
/// mistake here would fail loudly in the direction-table tests rather than
/// silently corrupting bounce-back/free-slip.
pub const Q: usize = 19;

pub const C: [[i32; 3]; Q] = [
    [0, 0, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [1, 1, 0],
    [-1, -1, 0],
    [1, -1, 0],
    [-1, 1, 0],
    [1, 0, 1],
    [-1, 0, -1],
    [1, 0, -1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, -1],
    [0, 1, -1],
    [0, -1, 1],
];

const W0: f32 = 1.0 / 3.0;
const W1: f32 = 1.0 / 18.0;
const W2: f32 = 1.0 / 36.0;

pub const W: [f32; Q] = [
    W0, W1, W1, W1, W1, W1, W1, W2, W2, W2, W2, W2, W2, W2, W2, W2, W2, W2, W2,
];

/// Lattice speed of sound squared, cs^2 = 1/3 for D3Q19 — fixed by the
/// velocity set/weight choice above, not a free parameter.
pub const CS2: f32 = 1.0 / 3.0;

fn find_direction(target: [i32; 3]) -> usize {
    C.iter()
        .position(|&c| c == target)
        .expect("target is not a valid D3Q19 offset")
}

/// `C` as `Vec3` for dot-product use in `feq`. Derived from `C`, not
/// hand-duplicated, so the two arrays can never drift apart.
pub fn c_vec() -> &'static [Vec3; Q] {
    static TABLE: OnceLock<[Vec3; Q]> = OnceLock::new();
    TABLE.get_or_init(|| std::array::from_fn(|i| Vec3::new(C[i][0] as f32, C[i][1] as f32, C[i][2] as f32)))
}

/// `opposite()[i]` is the direction index for `-C[i]` — the bounce-back pair.
pub fn opposite() -> &'static [usize; Q] {
    static TABLE: OnceLock<[usize; Q]> = OnceLock::new();
    TABLE.get_or_init(|| std::array::from_fn(|i| find_direction([-C[i][0], -C[i][1], -C[i][2]])))
}

/// `mirror_y()[i]` is the direction index for `C[i]` with its Y component
/// negated — used by the free-slip boundary to substitute the specular
/// (Y-reflected) population for one that would have streamed in from
/// outside the domain along Y.
pub fn mirror_y() -> &'static [usize; Q] {
    static TABLE: OnceLock<[usize; Q]> = OnceLock::new();
    TABLE.get_or_init(|| {
        std::array::from_fn(|i| {
            let mut t = C[i];
            t[1] = -t[1];
            find_direction(t)
        })
    })
}

/// As `mirror_y`, but negating the Z component.
pub fn mirror_z() -> &'static [usize; Q] {
    static TABLE: OnceLock<[usize; Q]> = OnceLock::new();
    TABLE.get_or_init(|| {
        std::array::from_fn(|i| {
            let mut t = C[i];
            t[2] = -t[2];
            find_direction(t)
        })
    })
}

/// Second-order Maxwell-Boltzmann equilibrium distribution for direction `i`
/// at density `rho` and lattice velocity `u`.
pub fn feq(i: usize, rho: f32, u: Vec3) -> f32 {
    let c = c_vec()[i];
    let cu = c.dot(u);
    let uu = u.dot(u);
    W[i] * rho * (1.0 + cu / CS2 + (cu * cu) / (2.0 * CS2 * CS2) - uu / (2.0 * CS2))
}

/// Inverse of `VoxelGrid::index` (`x + nx*(y + ny*z)`) — kept in lockstep
/// with that convention since streaming needs to recover (x,y,z) from a flat
/// buffer position to test domain-edge overflow per axis.
pub fn unflatten(idx: usize, nx: usize, ny: usize) -> (usize, usize, usize) {
    let x = idx % nx;
    let rem = idx / nx;
    let y = rem % ny;
    let z = rem / ny;
    (x, y, z)
}

/// Structure-of-arrays D3Q19 population storage over a dense `nx*ny*nz`
/// domain (SOLID cells included, flattened `x + nx*(y + ny*z)` to match
/// `VoxelGrid`). SOLID-cell entries are never read by collision or streaming
/// (see `streaming::stream`) — they hold whatever `new_at_rest` put there.
#[derive(Debug, Clone)]
pub struct Lattice {
    pub dims: (usize, usize, usize),
    pub f: [Vec<f32>; Q],
}

impl Lattice {
    pub fn len(&self) -> usize {
        self.dims.0 * self.dims.1 * self.dims.2
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn index(&self, x: usize, y: usize, z: usize) -> usize {
        x + self.dims.0 * (y + self.dims.1 * z)
    }

    /// Every cell (including SOLID ones) initialized to the equilibrium
    /// distribution for `(rho0, Vec3::ZERO)` — a physically sane, isotropic
    /// starting point that boundary conditions then drive away from.
    pub fn new_at_rest(dims: (usize, usize, usize), rho0: f32) -> Self {
        Self::new_uniform(dims, rho0, Vec3::ZERO)
    }

    pub fn new_uniform(dims: (usize, usize, usize), rho0: f32, u0: Vec3) -> Self {
        let n = dims.0 * dims.1 * dims.2;
        let f = std::array::from_fn(|i| vec![feq(i, rho0, u0); n]);
        Self { dims, f }
    }

    pub fn density(&self, idx: usize) -> f32 {
        (0..Q).map(|i| self.f[i][idx]).sum()
    }

    pub fn momentum(&self, idx: usize) -> Vec3 {
        let c = c_vec();
        (0..Q).fold(Vec3::ZERO, |acc, i| acc + c[i] * self.f[i][idx])
    }

    pub fn velocity(&self, idx: usize, rho: f32) -> Vec3 {
        if rho > 1e-8 {
            self.momentum(idx) / rho
        } else {
            Vec3::ZERO
        }
    }

    /// Per-cell density and velocity for the whole domain in one rayon pass
    /// each — the shared building block for collision (needs the local
    /// equilibrium target) and for sampling/diagnostics (needs the final
    /// field).
    pub fn fields(&self) -> (Vec<f32>, Vec<Vec3>) {
        (0..self.len())
            .into_par_iter()
            .map(|idx| {
                let rho = self.density(idx);
                (rho, self.velocity(idx, rho))
            })
            .unzip()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_sum_to_one() {
        let sum: f32 = W.iter().sum();
        assert!((sum - 1.0).abs() < 1e-6, "D3Q19 weights must sum to 1, got {sum}");
    }

    #[test]
    fn opposite_reverses_every_component() {
        let opp = opposite();
        for i in 0..Q {
            let c = C[i];
            let co = C[opp[i]];
            assert_eq!(co, [-c[0], -c[1], -c[2]], "opposite({i}) failed");
            assert_eq!(opp[opp[i]], i, "opposite must be an involution");
        }
    }

    #[test]
    fn mirror_tables_flip_only_their_own_axis() {
        let my = mirror_y();
        let mz = mirror_z();
        for i in 0..Q {
            let c = C[i];
            assert_eq!(C[my[i]], [c[0], -c[1], c[2]], "mirror_y({i}) failed");
            assert_eq!(C[mz[i]], [c[0], c[1], -c[2]], "mirror_z({i}) failed");
            assert_eq!(my[my[i]], i, "mirror_y must be an involution");
            assert_eq!(mz[mz[i]], i, "mirror_z must be an involution");
        }
    }

    #[test]
    fn equilibrium_at_rest_has_zero_velocity_and_matches_density() {
        let rho = 1.3_f32;
        let sum: f32 = (0..Q).map(|i| feq(i, rho, Vec3::ZERO)).sum();
        assert!((sum - rho).abs() < 1e-5, "sum(feq) should equal rho, got {sum}");
        let momentum: Vec3 = (0..Q).fold(Vec3::ZERO, |acc, i| acc + c_vec()[i] * feq(i, rho, Vec3::ZERO));
        assert!(momentum.length() < 1e-5, "at-rest equilibrium should have zero momentum, got {momentum}");
    }

    /// The whole point of the D3Q19 weight/velocity choice: feq's zeroth and
    /// first moments must exactly reproduce the (rho, u) it was built from,
    /// for ANY u, not just zero. This is what makes BGK collision exactly
    /// mass- and momentum-conserving (see collision.rs tests).
    #[test]
    fn equilibrium_moments_match_input_density_and_velocity() {
        let rho = 0.87_f32;
        let u = Vec3::new(0.05, -0.02, 0.01);
        let sum: f32 = (0..Q).map(|i| feq(i, rho, u)).sum();
        assert!((sum - rho).abs() < 1e-4, "sum(feq) should equal rho, got {sum}");
        let momentum: Vec3 = (0..Q).fold(Vec3::ZERO, |acc, i| acc + c_vec()[i] * feq(i, rho, u));
        let expected = rho * u;
        assert!((momentum - expected).length() < 1e-4, "momentum(feq) {momentum} should equal rho*u {expected}");
    }

    #[test]
    fn unflatten_inverts_voxelgrid_flattening() {
        let (nx, ny, nz) = (4usize, 5usize, 6usize);
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let idx = x + nx * (y + ny * z);
                    assert_eq!(unflatten(idx, nx, ny), (x, y, z));
                }
            }
        }
    }
}
