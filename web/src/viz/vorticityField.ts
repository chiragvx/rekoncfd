import * as THREE from "three";

import type { DecodedSolveResult } from "../net/protocol";

// Sequential "heat" colormap for a magnitude-only quantity (always >= 0) --
// deliberately distinct from the pressure view's diverging blue-white-red
// and the streamlines' blue-teal-yellow, so all three overlays read as
// different quantities when shown together.
const HOT_STOPS: [number, THREE.Color][] = [
  [0.0, new THREE.Color(0x0b1f3a)],
  [0.33, new THREE.Color(0x2bd1ff)],
  [0.66, new THREE.Color(0xffd23f)],
  [1.0, new THREE.Color(0xffffff)],
];

function hotColormap(t: number): THREE.Color {
  const clamped = THREE.MathUtils.clamp(t, 0, 1);
  for (let i = 1; i < HOT_STOPS.length; i++) {
    const [t0, c0] = HOT_STOPS[i - 1];
    const [t1, c1] = HOT_STOPS[i];
    if (clamped <= t1) {
      return c0.clone().lerp(c1, (clamped - t0) / (t1 - t0));
    }
  }
  return HOT_STOPS[HOT_STOPS.length - 1][1];
}

// Most of a wind-tunnel domain is undisturbed free-stream, so the vorticity
// field is overwhelmingly near-zero numerical noise with the real structure
// confined to a small fraction of cells. Measured on a representative
// blocked-channel solve: the 80th percentile of |curl| sits at just 0.6% of
// the peak, the 90th at 7%, the 95th at 27%. A flat "show the top 20% of
// cells" rule therefore showed almost entirely noise, sprayed across the
// whole domain -- which is exactly what it looked like.
//
// Instead the threshold is the STRICTER of a fraction-of-peak floor (kills
// the noise: at 10% of peak the same solve shows 8.8% of cells) and a
// percentile cap (bounds the point count if a field really is broadly
// rotational, where a fraction-of-peak rule alone would show everything).
const MIN_FRACTION_OF_PEAK = 0.1;
const MAX_SHOWN_PERCENTILE = 0.9;
const POINT_SIZE = 0.006;

/** Static (non-advected) point cloud highlighting the highest-vorticity
 * region of the last LBM solve's velocity field -- a curl-magnitude proxy
 * for "where is the flow rotational/turbulent," computed once per solve
 * (unlike `Streamlines`' continuously-advected particles) via finite
 * differences directly on the solved velocity grid. No server-side change
 * needed: `SolveResult` already carries the full velocity grid + its domain
 * bounds, which is all a curl calculation needs. */
export class VorticityField {
  private readonly scene: THREE.Scene;
  private points: THREE.Points | null = null;
  private visible = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setField(result: DecodedSolveResult) {
    this.dispose();

    const [nx, ny, nz] = result.velDims;
    const v = result.velocity;
    const [minX, minY, minZ] = result.domainMin;
    const [maxX, maxY, maxZ] = result.domainMax;
    const dx = (maxX - minX) / nx;
    const dy = (maxY - minY) / ny;
    const dz = (maxZ - minZ) / nz;

    // Clamped neighbor lookup -- gives one-sided differences at the domain
    // boundary instead of wrapping or reading out of bounds.
    const at = (xi: number, yi: number, zi: number, comp: number): number => {
      const cx = Math.min(Math.max(xi, 0), nx - 1);
      const cy = Math.min(Math.max(yi, 0), ny - 1);
      const cz = Math.min(Math.max(zi, 0), nz - 1);
      return v[(cx + nx * (cy + ny * cz)) * 3 + comp];
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

    const sorted = Float32Array.from(mags).sort();
    const maxMag = Math.max(sorted[cellCount - 1], 1e-9);
    const threshold = Math.max(
      MIN_FRACTION_OF_PEAK * maxMag,
      sorted[Math.floor((cellCount - 1) * MAX_SHOWN_PERCENTILE)],
    );

    const positions: number[] = [];
    const colors: number[] = [];
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const mag = mags[x + nx * (y + ny * z)];
          if (mag < threshold) continue;
          positions.push(minX + (x + 0.5) * dx, minY + (y + 0.5) * dy, minZ + (z + 0.5) * dz);
          // Renormalize across [threshold, peak] rather than [0, peak]:
          // everything below the threshold is hidden anyway, so mapping the
          // shown band across the FULL colormap is what makes relative
          // intensity among the hotspots readable instead of squashing them
          // all into the colormap's top end.
          const c = hotColormap((mag - threshold) / Math.max(maxMag - threshold, 1e-9));
          colors.push(c.r, c.g, c.b);
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({ size: POINT_SIZE, vertexColors: true, transparent: true, opacity: 0.8, sizeAttenuation: true });
    this.points = new THREE.Points(geometry, material);
    this.points.visible = this.visible;
    this.scene.add(this.points);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (this.points) this.points.visible = visible;
  }

  dispose() {
    if (!this.points) return;
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.points = null;
  }
}
