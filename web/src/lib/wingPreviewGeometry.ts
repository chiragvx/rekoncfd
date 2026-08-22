/**
 * Client-side mirror of `rekon_geometry::naca::generate_wing`'s ruled-surface
 * construction, for the Airfoil Generator's 3D preview only -- same "instant
 * preview, not the source of truth" role `airfoilPreview.ts` plays for the
 * 2D section (the actual mesh always comes from the Rust server once you hit
 * "Generate & Open in Tool").
 */

import * as THREE from "three";

import { sampleAirfoil, type PreviewAirfoil } from "@/lib/airfoilPreview";

export type WingPreviewParams = {
  airfoil: PreviewAirfoil;
  spanM: number;
  rootChordM: number;
  tipChordM: number;
  sweepDeg: number;
  dihedralDeg: number;
  washoutDeg: number;
};

const N_CHORD = 28;
const N_SPAN_HALF = 16; // stations per half-span, root included

export function buildWingGeometry(params: WingPreviewParams): THREE.BufferGeometry {
  const { upper, lower } = sampleAirfoil(params.airfoil, N_CHORD);
  // One ring per station: upper LE->TE, then lower TE->LE excluding both
  // shared endpoints -- matches the Rust side's `n_per_ring` vertex order so
  // the same alternating-split triangulation below stays a valid ruled quad
  // strip between adjacent rings.
  const sectionPoints: [number, number][] = [...upper, ...lower.slice(1, -1).reverse()];
  const nPerRing = sectionPoints.length;

  const halfSpan = params.spanM * 0.5;
  const sweep = (params.sweepDeg * Math.PI) / 180;
  const dihedral = (params.dihedralDeg * Math.PI) / 180;
  const washout = (params.washoutDeg * Math.PI) / 180;
  const pivotXFrac = 0.25;

  const nSpan = 2 * N_SPAN_HALF - 1;
  const vertices: THREE.Vector3[] = [];
  const ringMeta: { z: number; chord: number; leX: number; yDihedral: number }[] = [];

  for (let k = 0; k < nSpan; k++) {
    const t = k / (nSpan - 1);
    const z = -halfSpan + t * params.spanM;
    const s = Math.min(Math.abs(z) / halfSpan, 1);
    const chord = params.rootChordM + (params.tipChordM - params.rootChordM) * s;
    const leX = Math.tan(sweep) * Math.abs(z);
    const yDihedral = Math.tan(dihedral) * Math.abs(z);
    const twist = washout * s;
    const sinTw = Math.sin(twist);
    const cosTw = Math.cos(twist);

    ringMeta.push({ z, chord, leX, yDihedral });

    for (const [xf, yf] of sectionPoints) {
      const x = xf * chord;
      const y = yf * chord;
      const px = pivotXFrac * chord;
      const dx = x - px;
      const dy = y;
      const xt = px + dx * cosTw - dy * sinTw;
      const yt = dy * cosTw + dx * sinTw;
      vertices.push(new THREE.Vector3(leX + xt, yDihedral + yt, z));
    }
  }

  const ringIndex = (k: number, i: number) => k * nPerRing + (i % nPerRing);

  const positions: number[] = [];
  const pushTri = (a: number, b: number, c: number) => {
    for (const idx of [a, b, c]) {
      const v = vertices[idx];
      positions.push(v.x, v.y, v.z);
    }
  };

  for (let k = 0; k < nSpan - 1; k++) {
    for (let i = 0; i < nPerRing; i++) {
      const a = ringIndex(k, i);
      const b = ringIndex(k, i + 1);
      const c = ringIndex(k + 1, i + 1);
      const d = ringIndex(k + 1, i);
      if (i < N_CHORD - 1) {
        pushTri(a, b, c);
        pushTri(a, c, d);
      } else {
        pushTri(a, b, d);
        pushTri(b, c, d);
      }
    }
  }

  for (const k of [0, nSpan - 1]) {
    const { z, chord, leX, yDihedral } = ringMeta[k];
    const centroid = new THREE.Vector3(leX + chord * 0.5, yDihedral, z);
    for (let i = 0; i < nPerRing; i++) {
      const a = vertices[ringIndex(k, i)];
      const b = vertices[ringIndex(k, i + 1)];
      positions.push(centroid.x, centroid.y, centroid.z, a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
