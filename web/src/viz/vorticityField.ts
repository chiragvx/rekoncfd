import * as THREE from "three";

import type { DecodedSolveResult } from "../net/protocol";
import { computeVorticityMagnitudes } from "./fieldSampler";

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
  private readonly scene: THREE.Object3D;
  private points: THREE.Points | null = null;
  private visible = false;

  constructor(scene: THREE.Object3D) {
    this.scene = scene;
  }

  setField(result: DecodedSolveResult) {
    this.dispose();

    const [nx, ny, nz] = result.velDims;
    const [minX, minY, minZ] = result.domainMin;
    const [maxX, maxY, maxZ] = result.domainMax;
    const domainSize = new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ);
    const dx = domainSize.x / nx;
    const dy = domainSize.y / ny;
    const dz = domainSize.z / nz;

    const cellCount = nx * ny * nz;
    const mags = computeVorticityMagnitudes(result.velocity, result.velDims, domainSize);

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
