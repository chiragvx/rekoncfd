import * as THREE from "three";

// Coolwarm-style diverging colormap: blue (suction, Cp < 0) -> white (Cp ~ 0)
// -> red (compression, Cp > 0).
const STOPS: [number, THREE.Color][] = [
  [0.0, new THREE.Color(0x2b6cff)],
  [0.5, new THREE.Color(0xf2f2f2)],
  [1.0, new THREE.Color(0xd6362a)],
];

function colormap(t: number): THREE.Color {
  const clamped = THREE.MathUtils.clamp(t, 0, 1);
  for (let i = 1; i < STOPS.length; i++) {
    const [t0, c0] = STOPS[i - 1];
    const [t1, c1] = STOPS[i];
    if (clamped <= t1) {
      const localT = (clamped - t0) / (t1 - t0);
      return c0.clone().lerp(c1, localT);
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/** A symmetric-about-zero scale derived from the 95th percentile of |Cp| in
 * the current data, not a fixed constant: the panel method's inviscid Cp and
 * the LBM's isothermal-equation-of-state Cp live on genuinely different
 * scales (the LBM's is normalized by a deliberately small reference dynamic
 * pressure — see rekon-app's ws/lbm.rs U_LATTICE — so its Cp swings are much
 * larger), and a fixed range calibrated for one saturates solid-color on the
 * other. Symmetric-about-zero keeps Cp=0 mapped to the colormap's neutral
 * (white) midpoint, which is what makes a diverging colormap legible; the
 * 95th percentile (rather than the raw max) keeps a handful of noisy
 * near-wall outlier vertices from washing out the rest of the surface.
 */
function robustSymmetricScale(cp: Float32Array): number {
  const n = cp.length;
  if (n === 0) return 1;
  const abs = new Float32Array(n);
  for (let i = 0; i < n; i++) abs[i] = Math.abs(cp[i]);
  abs.sort();
  const idx = Math.min(n - 1, Math.floor(n * 0.95));
  return Math.max(abs[idx], 1e-6);
}

/** Writes a `color` BufferAttribute on `geometry` from per-vertex Cp values. */
export function applyPressureColors(geometry: THREE.BufferGeometry, cp: Float32Array) {
  const vertexCount = geometry.attributes.position.count;
  let colorAttr = geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
  if (!colorAttr || colorAttr.count !== vertexCount) {
    colorAttr = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
    geometry.setAttribute("color", colorAttr);
  }

  const scale = robustSymmetricScale(cp);
  const n = Math.min(vertexCount, cp.length);
  for (let i = 0; i < n; i++) {
    const t = cp[i] / scale / 2 + 0.5; // Cp in [-scale, scale] -> t in [0, 1], Cp=0 -> t=0.5
    const c = colormap(t);
    colorAttr.setXYZ(i, c.r, c.g, c.b);
  }
  colorAttr.needsUpdate = true;
}

/** Resets `geometry`'s vertex colors to the same neutral gray `setGeometry`
 * uses as its pre-first-PanelResult placeholder -- used when the pressure
 * overlay is toggled off, so the surface stays visible (other overlays like
 * streamlines still want it as a spatial reference) without implying a
 * pressure reading that isn't currently being shown. */
export function applyNeutralColor(geometry: THREE.BufferGeometry) {
  const vertexCount = geometry.attributes.position.count;
  let colorAttr = geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
  if (!colorAttr || colorAttr.count !== vertexCount) {
    colorAttr = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
    geometry.setAttribute("color", colorAttr);
  }
  for (let i = 0; i < vertexCount; i++) {
    colorAttr.setXYZ(i, 0.85, 0.85, 0.85);
  }
  colorAttr.needsUpdate = true;
}
