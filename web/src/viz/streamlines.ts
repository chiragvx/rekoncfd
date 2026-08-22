import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import { FieldSampler, SliceAxis, turbulenceColormap } from "./fieldSampler";

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

/** Screen-space line width in CSS pixels -- native WebGL line primitives are
 * clamped to 1px on most desktop backends regardless of what's requested
 * (a well-known three.js/ANGLE limitation), which is exactly why these were
 * hard to see clearly before. `LineSegments2`/`LineMaterial` render lines as
 * camera-facing screen-space quads instead, so this value actually applies. */
const LINE_WIDTH_PX = 2.5;
/** Square root of the vorticity-scale fraction is used (not the fraction
 * itself) so the colormap reddens readily even at modest vorticity rather
 * than only right at the reference scale -- "any turbulence shows," not
 * "only strong turbulence shows." */
const TURBULENCE_GAMMA = 0.5;

/** Streamlines of the solved velocity field, integrated as COMPLETE curves
 * from a plane of release points (ParaView/OpenFOAM "stream tracer with a
 * plane source"): each seed is traced both downstream and upstream until it
 * leaves the domain or stagnates, and the whole curve is drawn permanently,
 * fully formed, the instant it's built -- there is no animation of any kind
 * (no travelling particles, no travelling brightness wave), matching how a
 * real CFD post-processor like ParaView/SimFlow renders a stream tracer.
 * Colored by local vorticity magnitude (calm blue -> turbulent red) rather
 * than speed, so a line passing through disturbed air is visually obvious
 * without needing the separate vorticity-hotspot overlay turned on.
 *
 * Integration is RK2 (midpoint) with a fixed arc-length step. */
export class Streamlines {
  private readonly scene: THREE.Object3D;
  private readonly renderer: THREE.WebGLRenderer;
  private lines: LineSegments2 | null = null;
  private material: LineMaterial | null = null;
  private readonly sizeScratch = new THREE.Vector2();

  private sampler: FieldSampler | null = null;
  private visible = true;
  private needsRebuild = false;

  private seedPlaneEnabled = false;
  private seedPlaneAxis: SliceAxis = SliceAxis.X;
  private seedPlanePosition01 = 0.1;

  constructor(scene: THREE.Object3D, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.renderer = renderer;
  }

  setField(sampler: FieldSampler) {
    this.sampler = sampler;
    this.needsRebuild = true;
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
   * xyz plus the vorticity magnitude at each point (already normalized by
   * `vorticityScale`, mirroring how speed used to be normalized here). */
  private trace(seed: THREE.Vector3, direction: number, step: number): { pts: number[]; vorticities: number[] } {
    const s = this.sampler!;
    const min = s.domainMin;
    const max = s.domainMax;
    const minSpeed = s.speedScale * MIN_SPEED_FRACTION;

    const pts: number[] = [];
    const vorticities: number[] = [];
    const p = seed.clone();
    const v = new THREE.Vector3();
    const mid = new THREE.Vector3();

    for (let n = 0; n < MAX_POINTS_PER_DIR; n++) {
      s.sample(p.x, p.y, p.z, v);
      const speed = v.length();
      if (!Number.isFinite(speed) || speed < minSpeed) break;

      pts.push(p.x, p.y, p.z);
      vorticities.push(s.sampleVorticity(p.x, p.y, p.z) / s.vorticityScale);

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
    return { pts, vorticities };
  }

  private rebuild() {
    const s = this.sampler;
    if (!s) return;
    this.disposeGeometry();

    const step = Math.max(s.domainSize.x * STEP_FRACTION, 1e-6);

    // Each seed's full curve = upstream trace reversed, then downstream.
    const curves: { pts: number[]; vorticities: number[] }[] = [];
    for (const seed of this.seedPoints()) {
      const back = this.trace(seed, -1, step);
      const fwd = this.trace(seed, +1, step);

      const pts: number[] = [];
      const vorticities: number[] = [];
      for (let i = back.vorticities.length - 1; i >= 1; i--) {
        pts.push(back.pts[i * 3], back.pts[i * 3 + 1], back.pts[i * 3 + 2]);
        vorticities.push(back.vorticities[i]);
      }
      pts.push(...fwd.pts);
      vorticities.push(...fwd.vorticities);
      if (vorticities.length >= 2) curves.push({ pts, vorticities });
    }

    const segmentCount = curves.reduce((n, c) => n + c.vorticities.length - 1, 0);
    if (segmentCount === 0) return;

    const vertexCount = segmentCount * 2;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const color = new THREE.Color();

    let vi = 0;
    for (const curve of curves) {
      const n = curve.vorticities.length;
      for (let i = 0; i < n - 1; i++) {
        const a = i * 3;
        const b = (i + 1) * 3;

        const o = vi * 3;
        positions[o] = curve.pts[a];
        positions[o + 1] = curve.pts[a + 1];
        positions[o + 2] = curve.pts[a + 2];
        positions[o + 3] = curve.pts[b];
        positions[o + 4] = curve.pts[b + 1];
        positions[o + 5] = curve.pts[b + 2];

        turbulenceColormap(Math.pow(THREE.MathUtils.clamp(curve.vorticities[i], 0, 1), TURBULENCE_GAMMA), color);
        colors[o] = color.r;
        colors[o + 1] = color.g;
        colors[o + 2] = color.b;
        turbulenceColormap(Math.pow(THREE.MathUtils.clamp(curve.vorticities[i + 1], 0, 1), TURBULENCE_GAMMA), color);
        colors[o + 3] = color.r;
        colors[o + 4] = color.g;
        colors[o + 5] = color.b;

        vi += 2;
      }
    }

    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);

    const material = new LineMaterial({ vertexColors: true, transparent: true, opacity: 0.95, linewidth: LINE_WIDTH_PX });
    this.renderer.getSize(this.sizeScratch);
    material.resolution.copy(this.sizeScratch);

    this.material = material;
    this.lines = new LineSegments2(geometry, material);
    this.lines.visible = this.visible;
    // Long, self-overlapping curves; a stale bounding sphere would pop the
    // whole set out of view.
    this.lines.frustumCulled = false;
    this.scene.add(this.lines);
  }

  /** Rebuilds if needed, and keeps the line material's `resolution` uniform
   * in sync with the canvas size -- `LineMaterial` renders width in
   * screen-space pixels, so it needs this to stay correct across resizes.
   * Cheap enough to just refresh unconditionally every frame rather than
   * wiring a second resize observer alongside `RekonScene`'s own. */
  update() {
    if (this.needsRebuild) {
      this.needsRebuild = false;
      this.rebuild();
    }
    if (this.material) {
      this.renderer.getSize(this.sizeScratch);
      this.material.resolution.copy(this.sizeScratch);
    }
  }

  private disposeGeometry() {
    if (!this.lines) return;
    this.scene.remove(this.lines);
    this.lines.geometry.dispose();
    this.material?.dispose();
    this.lines = null;
    this.material = null;
  }

  dispose() {
    this.disposeGeometry();
    // Release the sampler (and through it the potentially large velocity
    // field) too, not just the Three.js objects.
    this.sampler = null;
    this.needsRebuild = false;
  }
}
