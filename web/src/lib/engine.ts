import { useEffect, useRef } from "react";
import * as THREE from "three";

import { createScene, startRenderLoop, type RekonScene } from "@/viewport/scene";
import { StlViewer } from "@/viewport/stlViewer";
import { WindTunnel } from "@/viewport/windTunnel";
import { Streamlines } from "@/viz/streamlines";
import { VorticityField } from "@/viz/vorticityField";
import { ContourPlane } from "@/viz/contourPlane";
import { FieldSampler, SliceAxis } from "@/viz/fieldSampler";
import { RekonSocket, wsUrlForCurrentHost } from "@/net/ws";
import {
  decodeFrame,
  decodeMeshGeometry,
  decodeMultiBankSweepFrame,
  decodePanelResult,
  decodePolarCurve,
  decodeSolveProgress,
  decodeSolveResult,
  decodeTrimResult,
  encodeMultiBankSweepRequest,
  encodePolarRequest,
  encodeSliderUpdate,
  encodeSolveFlowFieldRequest,
  encodeTrimRequest,
  Tag,
  type DecodedMeshGeometry,
  type DecodedPanelResult,
  type DecodedSolveProgress,
  type DecodedTrimResult,
  type MultiBankSweepFrame,
  type PolarPoint,
} from "@/net/protocol";

export interface SliderValues {
  alphaDeg: number;
  vInf: number;
  cg: { x: number; y: number; z: number };
  /** Real geometric bank (roll) angle -- see `RekonEngine.setBankDeg`. */
  bankDeg: number;
}

export interface AxisMappingSummary {
  chord: string;
  up: string;
  span: string;
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  release_notes: string | null;
}

export interface GenerateWingParams {
  naca: string;
  span_m: number;
  root_chord_m: number;
  tip_chord_m: number;
  sweep_deg: number;
  dihedral_deg: number;
  washout_deg: number;
  n_chord_stations: number;
  n_span_stations: number;
}

export interface ImportSummary {
  mesh_id: number;
  vertex_count: number;
  triangle_count: number;
  panel_count: number;
  bbox_min: [number, number, number];
  bbox_max: [number, number, number];
  span_m: number;
  chord_estimate_m: number;
  thickness_estimate_m: number;
  voxel_occupancy: number;
  warnings: string[];
  unit: string;
  unit_confident: boolean;
  mapping: AxisMappingSummary;
}

export interface VizState {
  pressure: boolean;
  streamlines: boolean;
  vorticity: boolean;
  contour: boolean;
  seedPlane: boolean;
  paused: boolean;
  planeAxis: SliceAxis;
  planePosition: number;
}

export const DEFAULT_VIZ_STATE: VizState = {
  pressure: true,
  streamlines: true,
  vorticity: false,
  contour: false,
  seedPlane: false,
  paused: false,
  planeAxis: SliceAxis.X,
  planePosition: 0.1,
};

type EventMap = {
  wsStatus: "connecting" | "open" | "closed";
  meshGeometry: DecodedMeshGeometry;
  meshCleared: void;
  panelResult: DecodedPanelResult;
  trimResult: DecodedTrimResult;
  polarCurve: PolarPoint[];
  bankSweepFrame: MultiBankSweepFrame;
  /** Fired whenever the model's bank angle changes -- live while dragging
   * the viewport's rotate control (no solve yet), on a committed slider
   * update, or from an applied bank-sweep frame -- so the rotate control's
   * own displayed angle stays in sync regardless of which of those changed
   * it. */
  bankDeg: number;
  solveProgress: DecodedSolveProgress;
  solveStarted: void;
  solveDone: number; // elapsed ms
  solveError: string;
  /** Fired after a successful import OR orient -- the one signal every
   * panel that depends on mesh metadata (chord estimate for CG ranging,
   * warnings, orientation state) needs, regardless of which of the two
   * requests produced it. */
  meshSummary: ImportSummary;
};

type Listener<K extends keyof EventMap> = (payload: EventMap[K]) => void;

/** Everything that ISN'T React: the Three.js scene/viewers and the
 * WebSocket/protocol plumbing, wrapped in one object with a tiny pub-sub so
 * React components can subscribe to server-driven events (mesh arrived,
 * panel result, trim result, ...) without those event types ever needing to
 * know React exists. One instance lives for the app's whole lifetime --
 * there is exactly one WS connection and one Three.js scene, so this is a
 * module-level singleton rather than something React creates/tears down. */
class RekonEngine {
  // Untyped internally (TS can't express "a Set whose element type depends
  // on this specific runtime key" across a mapped type without losing the
  // ability to insert/read generically) -- the public on/off/emit signatures
  // below are what actually keep this type-safe for callers.
  private listeners = new Map<keyof EventMap, Set<(payload: never) => void>>();

  private rs: RekonScene | null = null;
  private bankGroup: THREE.Group | null = null;
  private stlViewer: StlViewer | null = null;
  private windTunnel: WindTunnel | null = null;
  private streamlines: Streamlines | null = null;
  private vorticityField: VorticityField | null = null;
  private contourPlane: ContourPlane | null = null;
  private socket: RekonSocket | null = null;
  /** Mirrors the latest `wsStatus` emission so a component mounting AFTER
   * that status was already reached (e.g. re-visiting `/tool` once the
   * initial connect/fail has already resolved) can read it immediately
   * instead of waiting for a future event that may never fire again --
   * `RekonSocket` retries forever but only emits on actual state changes. */
  private wsStatus: "connecting" | "open" | "closed" = "connecting";

  private vizState: VizState = { ...DEFAULT_VIZ_STATE };
  private solveStartedAt = 0;
  /** The most recent (alpha, V) the Flight Condition panel has sent, cached
   * here (not owned by any one component) purely so the Solve panel's
   * "Solve Flow Field" button -- which has no other reason to know about
   * slider state -- can request a solve at the currently-displayed
   * condition without either panel needing a prop-drilled reference to
   * the other. */
  private lastSliderValues: SliderValues = { alphaDeg: 0, vInf: 15, cg: { x: 0, y: 0, z: 0 }, bankDeg: 0 };

  /** The scene/socket/etc. are created ONCE (by whichever component mounts
   * first / survives StrictMode's double-invoke in dev) and never rebuilt --
   * but `container` itself is NOT persistent: client-side routing away from
   * `/tool` and back tears down and recreates `Viewport`'s `<div>` every
   * time, so every call after the first must still re-parent the existing
   * canvas into whatever container this particular call was handed (see
   * `RekonScene.attachTo`'s doc comment) rather than silently no-op'ing --
   * that silent no-op used to be correct back when this was the app's one
   * always-mounted page, before routing existed. */
  mount(container: HTMLElement) {
    if (this.rs) {
      this.rs.attachTo(container);
      return;
    }

    const rs = createScene(container);
    this.rs = rs;

    // The bank-sweep solve rotates the MESH while holding the freestream
    // direction fixed -- exactly like a real wind tunnel, where the flow
    // direction never changes and the test article is mounted at an angle
    // within it. So the resulting velocity field (streamlines/vorticity/
    // contour) is already expressed in that same fixed lab frame; it needs
    // NO extra rotation to display correctly. Only the rendered MESH needs
    // one, since (for bandwidth) each frame resends just its Cp, not its
    // rotated vertex positions -- `bankGroup` exists purely to visually
    // match the mesh's rendering to the orientation it was actually solved
    // at. Putting the flow-field visualizations in this same rotating group
    // was the bug: it made the whole scene spin together as one rigid
    // assembly, showing "the same relative airflow, just rotated" instead
    // of a FIXED airflow being disrupted differently by a banking model.
    const bankGroup = new THREE.Group();
    rs.scene.add(bankGroup);
    this.bankGroup = bankGroup;

    this.stlViewer = new StlViewer(bankGroup);
    this.windTunnel = new WindTunnel(rs.scene);
    this.streamlines = new Streamlines(rs.scene);
    this.vorticityField = new VorticityField(rs.scene);
    this.contourPlane = new ContourPlane(rs.scene);
    this.applyVizState(this.vizState);

    const socket = new RekonSocket(wsUrlForCurrentHost("/ws"));
    this.socket = socket;
    socket.onStatus((status) => {
      this.wsStatus = status;
      this.emit("wsStatus", status);
    });

    socket.on(Tag.MeshGeometry, (buffer) => {
      // A fresh mesh should never inherit whatever bank angle a previous
      // sweep animation left the group rotated to.
      this.setBankDeg(0);
      this.lastSliderValues = { ...this.lastSliderValues, bankDeg: 0 };
      const decoded = decodeMeshGeometry(buffer);
      const box = this.stlViewer!.setGeometry(decoded);
      this.focusCameraOn(box);
      this.emit("meshGeometry", decoded);
    });
    socket.on(Tag.MeshCleared, () => {
      this.setBankDeg(0);
      this.lastSliderValues = { ...this.lastSliderValues, bankDeg: 0 };
      this.stlViewer!.dispose();
      this.streamlines!.dispose();
      this.vorticityField!.dispose();
      this.contourPlane!.dispose();
      this.windTunnel!.clear();
      this.emit("meshCleared", undefined);
    });
    socket.on(Tag.PanelResult, (buffer) => {
      const result = decodePanelResult(decodeFrame(buffer));
      this.stlViewer!.setPressure(result.cp);
      this.emit("panelResult", result);
    });
    socket.on(Tag.TrimResult, (buffer) => {
      this.emit("trimResult", decodeTrimResult(decodeFrame(buffer)));
    });
    socket.on(Tag.PolarCurve, (buffer) => {
      this.emit("polarCurve", decodePolarCurve(decodeFrame(buffer)));
    });
    socket.on(Tag.MultiBankSweepFrame, (buffer) => {
      this.emit("bankSweepFrame", decodeMultiBankSweepFrame(decodeFrame(buffer)));
    });
    socket.on(Tag.SolveProgress, (buffer) => {
      this.emit("solveProgress", decodeSolveProgress(decodeFrame(buffer)));
    });
    socket.on(Tag.SolveResult, (buffer) => {
      const result = decodeSolveResult(buffer);
      const sampler = new FieldSampler(result);
      this.streamlines!.setField(sampler);
      this.contourPlane!.setField(sampler);
      this.vorticityField!.setField(result);
      this.stlViewer!.setPressure(result.surfaceCp);
      // Snap the tunnel wireframe to the domain the solve ACTUALLY ran on --
      // see the historical note in the old main.ts: the box drawn at import
      // time is only a camera-framing guess, and the server's solve domain
      // uses a completely different sizing rule.
      this.windTunnel!.setBounds(new THREE.Vector3(...result.domainMin), new THREE.Vector3(...result.domainMax));
      this.emit("solveDone", performance.now() - this.solveStartedAt);
    });
    socket.on(Tag.SolveCancelledOrError, () => {
      this.emit("solveError", "solve failed to converge — try a lower angle of attack or airspeed");
    });
    socket.connect();

    startRenderLoop(rs, (dt) => this.streamlines?.update(dt));
  }

  private focusCameraOn(box: THREE.Box3) {
    const rs = this.rs;
    const windTunnel = this.windTunnel;
    if (!rs || !windTunnel) return;

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const radius = Math.max(size.length() * 0.5, 0.1);

    rs.controls.target.copy(center);
    rs.camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.8, radius));
    rs.camera.near = radius / 100;
    rs.camera.far = radius * 100;
    rs.camera.updateProjectionMatrix();
    rs.controls.update();

    const margin = size.clone().multiplyScalar(0.6).addScalar(0.05);
    windTunnel.setBounds(
      center.clone().sub(size.clone().multiplyScalar(0.5)).sub(margin),
      center.clone().add(size.clone().multiplyScalar(0.5)).add(margin),
    );
  }

  on<K extends keyof EventMap>(event: K, cb: Listener<K>) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as never);
    return () => this.off(event, cb);
  }

  off<K extends keyof EventMap>(event: K, cb: Listener<K>) {
    this.listeners.get(event)?.delete(cb as never);
  }

  private emit<K extends keyof EventMap>(event: K, payload: EventMap[K]) {
    this.listeners.get(event)?.forEach((cb) => (cb as Listener<K>)(payload));
  }

  sendSlider(values: SliderValues) {
    this.lastSliderValues = values;
    this.setBankDeg(values.bankDeg);
    this.socket?.send(encodeSliderUpdate(values.alphaDeg, values.vInf, values.cg, values.bankDeg));
  }

  getLastSliderValues(): SliderValues {
    return this.lastSliderValues;
  }

  getWsStatus(): "connecting" | "open" | "closed" {
    return this.wsStatus;
  }

  /** Rotates the RENDERED model to `deg` instantly, client-side only -- no
   * network round trip, no re-solve. Used for live visual feedback while
   * dragging the viewport's rotate control (a full re-solve at a new bank
   * angle costs a real panel-model rebuild, so it only happens once on
   * release -- see `RotateControl`), and internally by `sendSlider`/
   * `applyBankSweepFrame` to keep the rotate control's displayed angle in
   * sync with whatever last actually changed the bank. */
  setBankDeg(deg: number) {
    if (this.bankGroup) this.bankGroup.rotation.x = THREE.MathUtils.degToRad(deg);
    this.emit("bankDeg", deg);
  }

  requestTrim(bracket?: { alphaLoDeg: number; alphaHiDeg: number }) {
    this.socket?.send(encodeTrimRequest(bracket));
  }

  requestPolar(alphaMinDeg: number, alphaMaxDeg: number, nPoints: number) {
    this.socket?.send(encodePolarRequest(alphaMinDeg, alphaMaxDeg, nPoints));
  }

  /** Kicks off a "banked flight" animation: `nFrames` discrete frames
   * sweeping alpha and bank together, EACH a real re-solve (fresh panel
   * factorization + a full LBM run) on the mesh actually rotated to that
   * frame's bank angle. Genuinely slow -- frames stream back one at a time,
   * possibly minutes apart for the whole batch -- see `bankSweepFrame`. */
  requestBankSweep(alphaMinDeg: number, alphaMaxDeg: number, bankMinDeg: number, bankMaxDeg: number, nFrames: number) {
    this.socket?.send(encodeMultiBankSweepRequest(alphaMinDeg, alphaMaxDeg, bankMinDeg, bankMaxDeg, nFrames));
  }

  /** Applies one already-arrived bank-sweep frame to the viewport: recolors
   * the surface from that frame's REAL solved (LBM-derived) Cp, feeds its
   * REAL velocity field into streamlines/vorticity/contour (rendered in the
   * FIXED lab frame -- see `mount`'s comment, this is the flow a stationary
   * tunnel actually produces around the model at this bank angle, not
   * something that should spin with it), snaps the wind-tunnel wireframe to
   * that frame's actual solve domain, and rolls ONLY the rendered model to
   * `frame.bankDeg` to match the orientation it was actually solved at.
   * Everything here is real solved data for that specific rotated geometry,
   * not a cosmetic overlay. Also re-emits a `panelResult`-shaped event (from
   * the frame's panel-method coefficients) so `OutputBar` shows live
   * CL/CDi/Cm without its own separate animation-aware subscription. */
  applyBankSweepFrame(frame: MultiBankSweepFrame) {
    this.stlViewer?.setPressure(frame.surfaceCp);
    this.setBankDeg(frame.bankDeg);
    this.lastSliderValues = { ...this.lastSliderValues, bankDeg: frame.bankDeg };

    const sampler = new FieldSampler(frame);
    this.streamlines?.setField(sampler);
    this.contourPlane?.setField(sampler);
    this.vorticityField?.setField(frame);
    this.windTunnel?.setBounds(new THREE.Vector3(...frame.domainMin), new THREE.Vector3(...frame.domainMax));

    this.emit("panelResult", { cl: frame.cl, cdInduced: frame.cdInduced, cm: frame.cm, cp: frame.surfaceCp });
  }

  /** Solves at the currently-displayed flight condition (the Flight
   * Condition panel's last sent alpha/V, and the viewport rotate control's
   * last committed bank angle) unless overridden. */
  requestSolve(alphaDeg = this.lastSliderValues.alphaDeg, vInf = this.lastSliderValues.vInf, bankDeg = this.lastSliderValues.bankDeg) {
    this.solveStartedAt = performance.now();
    this.emit("solveStarted", undefined);
    this.socket?.send(encodeSolveFlowFieldRequest(alphaDeg, vInf, bankDeg));
  }

  /** Ground grid and wind-tunnel wireframe are scene/environment chrome, not
   * flow-field visualization -- kept separate from `VizState`/`applyVizState`
   * on purpose, since they're meaningful even with no mesh or solve loaded. */
  setGroundVisible(visible: boolean) {
    if (this.rs) this.rs.grid.visible = visible;
  }

  setWallsVisible(visible: boolean) {
    this.windTunnel?.setVisible(visible);
  }

  applyVizState(state: VizState) {
    this.vizState = state;
    this.stlViewer?.setPressureVisible(state.pressure);
    this.streamlines?.setVisible(state.streamlines);
    this.vorticityField?.setVisible(state.vorticity);
    this.contourPlane?.setVisible(state.contour);
    this.streamlines?.setPaused(state.paused);
    this.streamlines?.setSeedPlane(state.seedPlane, state.planeAxis, state.planePosition);
    this.contourPlane?.setSlice(state.planeAxis, state.planePosition);
  }

  async importFile(file: File): Promise<ImportSummary> {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/mesh/import", { method: "POST", body: formData });
    if (!response.ok) throw new Error(await response.text());
    const summary: ImportSummary = await response.json();
    this.emit("meshSummary", summary);
    return summary;
  }

  async orientMesh(mapping: AxisMappingSummary, unit: string): Promise<ImportSummary> {
    const response = await fetch("/api/mesh/orient", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chord_axis: mapping.chord, up_axis: mapping.up, span_axis: mapping.span, unit }),
    });
    if (!response.ok) throw new Error(await response.text());
    const summary: ImportSummary = await response.json();
    this.emit("meshSummary", summary);
    return summary;
  }

  async clearMesh(): Promise<void> {
    const response = await fetch("/api/mesh", { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text());
  }

  /** Builds a wing mesh server-side from NACA + planform parameters (the
   * Airfoil Generator) and loads it as the current mesh -- same effect as
   * an STL import, no upload round-trip. */
  async generateWing(params: GenerateWingParams): Promise<ImportSummary> {
    const response = await fetch("/api/mesh/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!response.ok) throw new Error(await response.text());
    const summary: ImportSummary = await response.json();
    this.emit("meshSummary", summary);
    return summary;
  }

  /** Loads one "Explore Models" catalog entry as the current mesh. */
  async loadSampleModel(id: string): Promise<ImportSummary> {
    const response = await fetch(`/api/models/${encodeURIComponent(id)}/load`, { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    const summary: ImportSummary = await response.json();
    this.emit("meshSummary", summary);
    return summary;
  }

  /** Only meaningful when running the desktop build's local server (a
   * hosted web deployment has no self-update path -- it's just redeployed).
   * Never throws: a check that fails (no release yet, offline) reads the
   * same as "no update available" -- see `rekon_app::updater`. */
  async getVersionInfo(): Promise<VersionInfo> {
    const response = await fetch("/api/version");
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  /** Downloads and installs the latest release over the currently-running
   * exe. The process keeps running its OLD code in memory until it exits --
   * the caller must tell the user to relaunch afterward. */
  async applyUpdate(): Promise<{ version: string }> {
    const response = await fetch("/api/update/apply", { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
}

export const engine = new RekonEngine();
export { SliceAxis };
export type { DecodedMeshGeometry, DecodedPanelResult, DecodedSolveProgress, DecodedTrimResult, PolarPoint };

/** Subscribes a component to one engine event for its whole mounted
 * lifetime. `cb` is read through a ref on every firing rather than being a
 * `useEffect` dependency, so callers can pass an inline closure (capturing
 * whatever local state it needs) without memoizing it themselves -- the
 * subscription itself is only ever set up once per `event`. */
export function useEngineEvent<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void) {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => engine.on(event, (payload) => cbRef.current(payload)), [event]);
}
