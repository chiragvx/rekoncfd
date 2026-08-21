import * as THREE from "three";

import { FieldSampler, SliceAxis, speedColormap } from "./fieldSampler";

/** Release points across the seed plane. Rendered as complete curves rather
 * than moving particles, so this is a count of STREAMLINES on screen. */
const SEED_COUNT = 210;
/** Columns in the seed-plane release grid; rows follow from the count. */
const RAKE_COLS = Math.max(1, Math.round(Math.sqrt(SEED_COUNT)));

/** Integration step as a fraction of the tunnel's streamwise extent. Fixed
 * ARC length per step (the direction is normalized before stepping), so
 * points are evenly spaced along the curve regardless of local speed --
 * which keeps line quality uniform and makes arc-length exact. */
const STEP_FRACTION = 1 / 200;
/** Safety cap per direction; only curves that spiral in a recirculation
 * zone ever reach it (a free-stream line exits the domain long before). */
const MAX_POINTS_PER_DIR = 500;
/** Below this fraction of the reference speed the flow is stagnant or the
 * point has entered the solid body, and integrating further is meaningless. */
const MIN_SPEED_FRACTION = 0.02;

// Travelling-brightness animation. Purely cosmetic: the geometry is static,
// so this conveys flow direction without any of the spawn/despawn popping
// that animating actual particles causes.
const PULSE_WAVELENGTH_FRACTION = 0.12;
const PULSE_TRAVEL_FRACTION_PER_S = 0.35;
const PULSE_LUT_SIZE = 256;

/** Precomputed one period of the pulse, so the per-frame color pass costs a
 * table lookup per vertex instead of a `sin`. */
const PULSE_LUT = (() => {
  const lut = new Float32Array(PULSE_LUT_SIZE);
  for (let i = 0; i < PULSE_LUT_SIZE; i++) {
    const s = 0.5 + 0.5 * Math.sin((2 * Math.PI * i) / PULSE_LUT_SIZE);
    lut[i] = 0.45 + 0.55 * s * s;
  }
  return lut;
})();

/** Streamlines of the solved velocity field, integrated as COMPLETE curves
 * from a plane of release points (ParaView/OpenFOAM "stream tracer with a
 * plane source"): each seed is traced both downstream and upstream until it
 * leaves the domain or stagnates, and the whole curve is drawn permanently.
 *
 * This replaced an animated-particle implementation. For a STEADY solved
 * field a streamline is a fixed curve, so animating particles along it was
 * redundant — and actively harmful: with a fixed seed grid every particle
 * was released at once and travelled in lockstep, so they all reached the
 * outlet together and respawned together, producing a visible pulse of
 * lines appearing and vanishing en masse. Static curves have no spawn
 * cycle at all, so there is nothing left to synchronize; flow direction is
 * conveyed by a travelling brightness wave instead, which never pops.
 *
 * Integration is RK2 (midpoint) with a fixed arc-length step. */
export class Streamlines {
  private readonly scene: THREE.Object3D;
  private lines: THREE.LineSegments | null = null;
  private positionAttr: THREE.BufferAttribute | null = null;
  private colorAttr: THREE.BufferAttribute | null = null;
  /** Per-vertex un-modulated color from local speed. */
  private baseColor: Float32Array | null = null;
  /** Per-vertex distance along its own curve, driving the pulse. */
  private arcLength: Float32Array | null = null;

  private sampler: FieldSampler | null = null;
  private visible = true;
  private paused = false;
  private time = 0;
  private needsRebuild = false;

  private seedPlaneEnabled = false;
  private seedPlaneAxis: SliceAxis = SliceAxis.X;
  private seedPlanePosition01 = 0.1;

  constructor(scene: THREE.Object3D) {
    this.scene = scene;
  }

  setField(sampler: FieldSampler) {
    this.sampler = sampler;
    this.needsRebuild = true;
  }

  /** Freezes the travelling pulse, leaving the curves drawn, so a structure
   * can be inspected/orbited without motion. */
  setPaused(paused: boolean) {
    this.paused = paused;
  }

  setSeedPlane(enabled: boolean, axis: SliceAxis, position01: number) {
    if (
      enabled === this.seedPlaneEnabled &&
      axis === this.seedPlaneAxis &&
      position01 === this.seedPlanePosition01
    ) {
      return;
    }
    this.seedPlaneEnabled = enabled;
    this.seedPlaneAxis = axis;
    this.seedPlanePosition01 = position01;
    // Deferred to the next frame rather than rebuilt here: dragging the
    // position slider fires a continuous stream of events, and coalescing
    // them to one rebuild per frame keeps the drag responsive.
    this.needsRebuild = true;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (this.lines) this.lines.visible = visible;
  }

  /** Release points: a regular grid over the chosen plane. With the seed
   * plane off this falls back to a cross-flow rake just inside the inlet,
   * which is the natural default for a wind tunnel. */
  private seedPoints(): THREE.Vector3[] {
    const s = this.sampler!;
    const min = s.domainMin;
    const size = s.domainSize;
    const axis = this.seedPlaneEnabled ? this.seedPlaneAxis : SliceAxis.X;
    const position = this.seedPlaneEnabled ? this.seedPlanePosition01 : 0.02;
    const coord = s.slicePlaneCoord(axis, position);

    const cols = RAKE_COLS;
    const rows = Math.ceil(SEED_COUNT / cols);
    // Inset from the tunnel walls, which are free-slip boundaries with
    // nothing interesting on them.
    const inset = (t: number) => 0.05 + 0.9 * t;

    const seeds: THREE.Vector3[] = [];
    for (let i = 0; i < SEED_COUNT; i++) {
      const u = inset(((i % cols) + 0.5) / cols);
      const v = inset((Math.floor(i / cols) + 0.5) / rows);
      if (axis === SliceAxis.X) {
        seeds.push(new THREE.Vector3(coord, min.y + size.y * u, min.z + size.z * v));
      } else if (axis === SliceAxis.Y) {
        seeds.push(new THREE.Vector3(min.x + size.x * u, coord, min.z + size.z * v));
      } else {
        seeds.push(new THREE.Vector3(min.x + size.x * u, min.y + size.y * v, coord));
      }
    }
    return seeds;
  }

  /** Traces one seed in one direction (+1 downstream, -1 upstream) until it
   * exits the domain, stagnates, or hits the point cap. Returns interleaved
   * xyz plus the normalized speed at each point. */
  private trace(seed: THREE.Vector3, direction: number, step: number): { pts: number[]; speeds: number[] } {
    const s = this.sampler!;
    const min = s.domainMin;
    const max = s.domainMax;
    const minSpeed = s.speedScale * MIN_SPEED_FRACTION;

    const pts: number[] = [];
    const speeds: number[] = [];
    const p = seed.clone();
    const v = new THREE.Vector3();
    const mid = new THREE.Vector3();

    for (let n = 0; n < MAX_POINTS_PER_DIR; n++) {
      s.sample(p.x, p.y, p.z, v);
      const speed = v.length();
      if (!Number.isFinite(speed) || speed < minSpeed) break;

      pts.push(p.x, p.y, p.z);
      speeds.push(speed / s.speedScale);

      // RK2 (midpoint): sample at the half-step to follow curvature far
      // better than plain Euler, which visibly drifts off tight vortices.
      mid.copy(p).addScaledVector(v, (direction * step * 0.5) / speed);
      s.sample(mid.x, mid.y, mid.z, v);
      const midSpeed = v.length();
      if (!Number.isFinite(midSpeed) || midSpeed < minSpeed) break;
      p.addScaledVector(v, (direction * step) / midSpeed);

      if (p.x < min.x || p.x > max.x || p.y < min.y || p.y > max.y || p.z < min.z || p.z > max.z) {
        break;
      }
    }
    return { pts, speeds };
  }

  private rebuild() {
    const s = this.sampler;
    if (!s) return;
    this.disposeGeometry();

    const step = Math.max(s.domainSize.x * STEP_FRACTION, 1e-6);

    // Each seed's full curve = upstream trace reversed, then downstream.
    const curves: { pts: number[]; speeds: number[] }[] = [];
    for (const seed of this.seedPoints()) {
      const back = this.trace(seed, -1, step);
      const fwd = this.trace(seed, +1, step);

      const pts: number[] = [];
      const speeds: number[] = [];
      for (let i = back.speeds.length - 1; i >= 1; i--) {
        pts.push(back.pts[i * 3], back.pts[i * 3 + 1], back.pts[i * 3 + 2]);
        speeds.push(back.speeds[i]);
      }
      pts.push(...fwd.pts);
      speeds.push(...fwd.speeds);
      if (speeds.length >= 2) curves.push({ pts, speeds });
    }

    const segmentCount = curves.reduce((n, c) => n + c.speeds.length - 1, 0);
    if (segmentCount === 0) return;

    const vertexCount = segmentCount * 2;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const base = new Float32Array(vertexCount * 3);
    const arc = new Float32Array(vertexCount);
    const color = new THREE.Color();

    let vi = 0;
    for (const curve of curves) {
      const n = curve.speeds.length;
      // Cumulative arc length along this curve, so the pulse travels at a
      // constant world speed regardless of how the curve bends.
      let travelled = 0;
      for (let i = 0; i < n - 1; i++) {
        const a = i * 3;
        const b = (i + 1) * 3;
        const dx = curve.pts[b] - curve.pts[a];
        const dy = curve.pts[b + 1] - curve.pts[a + 1];
        const dz = curve.pts[b + 2] - curve.pts[a + 2];
        const segLen = Math.hypot(dx, dy, dz);

        const o = vi * 3;
        positions[o] = curve.pts[a];
        positions[o + 1] = curve.pts[a + 1];
        positions[o + 2] = curve.pts[a + 2];
        positions[o + 3] = curve.pts[b];
        positions[o + 4] = curve.pts[b + 1];
        positions[o + 5] = curve.pts[b + 2];

        speedColormap(curve.speeds[i], color);
        base[o] = color.r;
        base[o + 1] = color.g;
        base[o + 2] = color.b;
        speedColormap(curve.speeds[i + 1], color);
        base[o + 3] = color.r;
        base[o + 4] = color.g;
        base[o + 5] = color.b;

        arc[vi] = travelled;
        arc[vi + 1] = travelled + segLen;
        travelled += segLen;
        vi += 2;
      }
    }

    const geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(positions, 3);
    this.colorAttr = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute("position", this.positionAttr);
    geometry.setAttribute("color", this.colorAttr);
    this.baseColor = base;
    this.arcLength = arc;

    const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 });
    this.lines = new THREE.LineSegments(geometry, material);
    this.lines.visible = this.visible;
    // Long, self-overlapping curves; a stale bounding sphere would pop the
    // whole set out of view.
    this.lines.frustumCulled = false;
    this.scene.add(this.lines);

    this.writeColors();
  }

  /** Modulates the precomputed base colors by the travelling pulse. */
  private writeColors() {
    const colors = this.colorAttr?.array as Float32Array | undefined;
    const base = this.baseColor;
    const arc = this.arcLength;
    const s = this.sampler;
    if (!colors || !base || !arc || !s) return;

    const wavelength = Math.max(s.domainSize.x * PULSE_WAVELENGTH_FRACTION, 1e-6);
    const travel = this.time * s.domainSize.x * PULSE_TRAVEL_FRACTION_PER_S;
    const invWavelength = 1 / wavelength;

    for (let i = 0; i < arc.length; i++) {
      let phase = (arc[i] - travel) * invWavelength;
      phase -= Math.floor(phase);
      const pulse = PULSE_LUT[(phase * PULSE_LUT_SIZE) | 0];
      const o = i * 3;
      colors[o] = base[o] * pulse;
      colors[o + 1] = base[o + 1] * pulse;
      colors[o + 2] = base[o + 2] * pulse;
    }
    this.colorAttr!.needsUpdate = true;
  }

  update(dt: number) {
    if (this.needsRebuild) {
      this.needsRebuild = false;
      this.rebuild();
    }
    if (this.paused || !this.lines) return;
    this.time += dt;
    this.writeColors();
  }

  private disposeGeometry() {
    if (!this.lines) return;
    this.scene.remove(this.lines);
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.lines = null;
    this.positionAttr = null;
    this.colorAttr = null;
    this.baseColor = null;
    this.arcLength = null;
  }

  dispose() {
    this.disposeGeometry();
    // Release the sampler (and through it the potentially large velocity
    // field) too, not just the Three.js objects.
    this.sampler = null;
    this.needsRebuild = false;
  }
}
