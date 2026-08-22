import * as THREE from "three";

import type { DecodedSolveResult } from "../net/protocol";

/** Which world axis a slice plane is perpendicular to. A const object rather
 * than an `enum`, which this project's TS config (`erasableSyntaxOnly`)
 * disallows -- same pattern as `net/protocol.ts`'s `Tag`. */
export const SliceAxis = { X: 0, Y: 1, Z: 2 } as const;
export type SliceAxis = (typeof SliceAxis)[keyof typeof SliceAxis];

// Speed colormap: distinct from the pressure view's diverging blue-white-red
// and the vorticity view's dark-cyan-yellow-white, so all of them read as
// separate quantities when shown at once.
const SPEED_STOPS: [number, THREE.Color][] = [
  [0.0, new THREE.Color(0x1b3a6b)],
  [0.5, new THREE.Color(0x2bd9a0)],
  [1.0, new THREE.Color(0xfff066)],
];

export function speedColormap(t: number, out: THREE.Color): THREE.Color {
  const clamped = THREE.MathUtils.clamp(t, 0, 1);
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    const [t0, c0] = SPEED_STOPS[i - 1];
    const [t1, c1] = SPEED_STOPS[i];
    if (clamped <= t1) {
      return out.copy(c0).lerp(c1, (clamped - t0) / (t1 - t0));
    }
  }
  return out.copy(SPEED_STOPS[SPEED_STOPS.length - 1][1]);
}

// Two-stop colormap for streamlines: calm blue where the local flow is
// smooth/undisturbed, shifting to red wherever vorticity picks up -- a
// different hue pairing from speed/pressure/the vorticity-hotspot cloud, so
// "is this streamline passing through disturbed air" reads at a glance
// without needing the separate vorticity overlay turned on too.
const TURBULENCE_STOPS: [THREE.Color, THREE.Color] = [new THREE.Color(0x2f6fd8), new THREE.Color(0xe0392f)];

export function turbulenceColormap(t: number, out: THREE.Color): THREE.Color {
  return out.copy(TURBULENCE_STOPS[0]).lerp(TURBULENCE_STOPS[1], THREE.MathUtils.clamp(t, 0, 1));
}

/** Curl magnitude at every grid cell, via central finite differences
 * (clamped/one-sided at the domain boundary) -- the same "how rotational is
 * the flow locally" quantity `VorticityField`'s hotspot point cloud shows.
 * Shared by both so streamline coloring and the vorticity overlay can never
 * silently disagree about what counts as vorticity. */
export function computeVorticityMagnitudes(
  velocity: Float32Array,
  dims: [number, number, number],
  domainSize: THREE.Vector3,
): Float32Array {
  const [nx, ny, nz] = dims;
  const dx = domainSize.x / nx;
  const dy = domainSize.y / ny;
  const dz = domainSize.z / nz;

  const at = (xi: number, yi: number, zi: number, comp: number): number => {
    const cx = Math.min(Math.max(xi, 0), nx - 1);
    const cy = Math.min(Math.max(yi, 0), ny - 1);
    const cz = Math.min(Math.max(zi, 0), nz - 1);
    return velocity[(cx + nx * (cy + ny * cz)) * 3 + comp];
  };

  const cellCount = nx * ny * nz;
  const mags = new Float32Array(cellCount);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        // curl = (d(vz)/dy - d(vy)/dz, d(vx)/dz - d(vz)/dx, d(vy)/dx - d(vx)/dy)
        const curlX = (at(x, y + 1, z, 2) - at(x, y - 1, z, 2)) / (2 * dy) - (at(x, y, z + 1, 1) - at(x, y, z - 1, 1)) / (2 * dz);
        const curlY = (at(x, y, z + 1, 0) - at(x, y, z - 1, 0)) / (2 * dz) - (at(x + 1, y, z, 2) - at(x - 1, y, z, 2)) / (2 * dx);
        const curlZ = (at(x + 1, y, z, 1) - at(x - 1, y, z, 1)) / (2 * dx) - (at(x, y + 1, z, 0) - at(x, y - 1, z, 0)) / (2 * dy);
        mags[x + nx * (y + ny * z)] = Math.hypot(curlX, curlY, curlZ);
      }
    }
  }
  return mags;
}

/** A high-percentile (not peak) scale for a magnitude-only field -- most of
 * a wind-tunnel domain is undisturbed free-stream, so the peak alone is an
 * outlier that would wash out everything else if used as the normalization
 * reference (see `VorticityField`'s own measured percentile breakdown). */
export function percentileScale(values: Float32Array, percentile: number): number {
  if (values.length === 0) return 1;
  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * percentile));
  return Math.max(sorted[idx], 1e-9);
}

/** Trilinear sampler over one solved velocity field, plus the robust speed
 * scale used to normalize it for coloring. Shared by every overlay that
 * reads the field (streamlines, contour plane) so they agree exactly on
 * both the interpolation and the color normalization. */
export class FieldSampler {
  readonly domainMin = new THREE.Vector3();
  readonly domainMax = new THREE.Vector3();
  readonly domainSize = new THREE.Vector3();
  readonly dims: [number, number, number];
  /** 95th-percentile speed magnitude across the whole field -- a robust
   * scale taken from the data itself, so no overlay needs to know the LBM's
   * internal lattice-velocity unit convention. */
  readonly speedScale: number;
  /** 90th-percentile curl magnitude -- the "full red" reference for
   * `turbulenceColormap`, chosen the same way `VorticityField` picks its
   * hotspot threshold: low enough that real (if modest) rotational regions
   * still show up clearly, not just the single most extreme cell. */
  readonly vorticityScale: number;
  private readonly velocity: Float32Array;
  private readonly vorticity: Float32Array;

  constructor(result: DecodedSolveResult) {
    this.velocity = result.velocity;
    this.dims = result.velDims;
    this.domainMin.set(...result.domainMin);
    this.domainMax.set(...result.domainMax);
    this.domainSize.subVectors(this.domainMax, this.domainMin);
    this.speedScale = robustSpeedScale(result.velocity);
    this.vorticity = computeVorticityMagnitudes(this.velocity, this.dims, this.domainSize);
    this.vorticityScale = percentileScale(this.vorticity, 0.9);
  }

  sample(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const [nx, ny, nz] = this.dims;
    const v = this.velocity;

    const fx = ((x - this.domainMin.x) / this.domainSize.x) * nx - 0.5;
    const fy = ((y - this.domainMin.y) / this.domainSize.y) * ny - 0.5;
    const fz = ((z - this.domainMin.z) / this.domainSize.z) * nz - 0.5;

    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;

    const clampIdx = (i: number, n: number) => Math.min(Math.max(i, 0), n - 1);
    const at = (xi: number, yi: number, zi: number, comp: number) => {
      const cx = clampIdx(xi, nx), cy = clampIdx(yi, ny), cz = clampIdx(zi, nz);
      return v[(cx + nx * (cy + ny * cz)) * 3 + comp];
    };
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const trilerp = (comp: number) => {
      const c00 = lerp(at(x0, y0, z0, comp), at(x0 + 1, y0, z0, comp), tx);
      const c10 = lerp(at(x0, y0 + 1, z0, comp), at(x0 + 1, y0 + 1, z0, comp), tx);
      const c01 = lerp(at(x0, y0, z0 + 1, comp), at(x0 + 1, y0, z0 + 1, comp), tx);
      const c11 = lerp(at(x0, y0 + 1, z0 + 1, comp), at(x0 + 1, y0 + 1, z0 + 1, comp), tx);
      return lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz);
    };

    return out.set(trilerp(0), trilerp(1), trilerp(2));
  }

  /** Trilinearly interpolated curl magnitude at a continuous point --
   * same indexing as `sample`, just over the scalar vorticity grid instead
   * of the 3-component velocity one. */
  sampleVorticity(x: number, y: number, z: number): number {
    const [nx, ny, nz] = this.dims;
    const v = this.vorticity;

    const fx = ((x - this.domainMin.x) / this.domainSize.x) * nx - 0.5;
    const fy = ((y - this.domainMin.y) / this.domainSize.y) * ny - 0.5;
    const fz = ((z - this.domainMin.z) / this.domainSize.z) * nz - 0.5;

    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;

    const clampIdx = (i: number, n: number) => Math.min(Math.max(i, 0), n - 1);
    const at = (xi: number, yi: number, zi: number) => {
      const cx = clampIdx(xi, nx), cy = clampIdx(yi, ny), cz = clampIdx(zi, nz);
      return v[cx + nx * (cy + ny * cz)];
    };
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const c00 = lerp(at(x0, y0, z0), at(x0 + 1, y0, z0), tx);
    const c10 = lerp(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), tx);
    const c01 = lerp(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), tx);
    const c11 = lerp(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), tx);
    return lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz);
  }

  /** World coordinate of a slice plane given a normalized 0..1 position
   * along its own normal axis. */
  slicePlaneCoord(axis: SliceAxis, position01: number): number {
    const t = THREE.MathUtils.clamp(position01, 0, 1);
    const min = axis === SliceAxis.X ? this.domainMin.x : axis === SliceAxis.Y ? this.domainMin.y : this.domainMin.z;
    const size = axis === SliceAxis.X ? this.domainSize.x : axis === SliceAxis.Y ? this.domainSize.y : this.domainSize.z;
    return min + size * t;
  }
}

function robustSpeedScale(velocity: Float32Array): number {
  const n = velocity.length / 3;
  if (n === 0) return 1;
  const speeds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    speeds[i] = Math.hypot(velocity[i * 3], velocity[i * 3 + 1], velocity[i * 3 + 2]);
  }
  speeds.sort();
  return Math.max(speeds[Math.min(n - 1, Math.floor(n * 0.95))], 1e-6);
}
