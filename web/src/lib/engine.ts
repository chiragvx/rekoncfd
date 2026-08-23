import { useEffect, useRef } from "react";
import * as THREE from "three";

import { createScene, startRenderLoop, type RekonScene } from "@/viewport/scene";
import { StlViewer } from "@/viewport/stlViewer";
import { WindTunnel } from "@/viewport/windTunnel";
import { DEFAULT_STREAMLINE_SETTINGS, Streamlines, type StreamlineSettings } from "@/viz/streamlines";
import { VorticityField } from "@/viz/vorticityField";
import { ContourPlane } from "@/viz/contourPlane";
import { FieldSampler, SliceAxis } from "@/viz/fieldSampler";
import { apiUrl, RekonSocket, resolveWsUrl } from "@/net/ws";
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
  /** Real geometric pitch rotation (about the span axis) -- what the UI
   * calls "AoA". See `RekonEngine.setAttitudeDeg`. */
  pitchDeg: number;
  vInf: number;
  cg: { x: number; y: number; z: number };
  /** Real geometric bank (roll) angle -- see `RekonEngine.setAttitudeDeg`. */
  bankDeg: number;
  /** Real geometric yaw angle (about the up axis) -- see
   * `RekonEngine.setAttitudeDeg`. */
  yawDeg: number;
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

/** How the CURRENT mesh got here -- tracked purely so a "save project"
 * feature (see `lib/projects.ts`) knows what to persist: a sample/generated
 * mesh only needs its (tiny, exact) source parameters re-run on load, while
 * an uploaded STL needs the actual file bytes kept around to re-upload. */
export type MeshSource =
  | { kind: "sample"; sampleId: string }
  | { kind: "generated"; params: GenerateWingParams }
  | { kind: "uploaded"; file: File };

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

/** LBM solve grid density/step count -- server-clamped (see
 * `ws::lbm::decode_solve_request`), so these are a REQUEST, not a
 * guarantee: `resolutionMultiplier` scales the solve's voxel grid (and the
 * velocity field sampled back from it) in all three axes together, and
 * `maxSteps` is the solver's step cap. Only takes effect on the next
 * "Solve Flow Field" click -- unlike `StreamlineSettings`, there's no cheap
 * way to apply a resolution/step change to an already-completed solve. */
export interface SolveQuality {
  resolutionMultiplier: number;
  maxSteps: number;
}

export const DEFAULT_SOLVE_QUALITY: SolveQuality = {
  resolutionMultiplier: 1.0,
  maxSteps: 400,
};

export interface VizState {
  pressure: boolean;
  streamlines: boolean;
  vorticity: boolean;
  contour: boolean;
  seedPlane: boolean;
  planeAxis: SliceAxis;
  planePosition: number;
  /** How streamlines are traced/rendered, as opposed to `streamlines` above
   * (whether they're shown at all) -- see the Settings menu. */
  streamlineSettings: StreamlineSettings;
  /** See `SolveQuality`'s doc comment. */
  solveQuality: SolveQuality;
}

export const DEFAULT_VIZ_STATE: VizState = {
  pressure: true,
  streamlines: true,
  vorticity: false,
  contour: false,
  seedPlane: false,
  planeAxis: SliceAxis.X,
  planePosition: 0.1,
  streamlineSettings: { ...DEFAULT_STREAMLINE_SETTINGS },
  solveQuality: { ...DEFAULT_SOLVE_QUALITY },
};

type EventMap = {
  wsStatus: "connecting" | "open" | "closed";
  meshGeometry: DecodedMeshGeometry;
  meshCleared: void;
  panelResult: DecodedPanelResult;
  trimResult: DecodedTrimResult;
  polarCurve: PolarPoint[];
  bankSweepFrame: MultiBankSweepFrame;
  /** Fired whenever the model's rendered attitude changes -- on a committed
   * slider update, or from an applied bank-sweep frame -- so any display
   * showing the current attitude stays in sync regardless of which of
   * those changed it. */
  attitudeDeg: { bankDeg: number; pitchDeg: number; yawDeg: number };
  /** Fired on every `sendSlider` call, whoever made it -- lets a display
   * (e.g. Flight Condition's own sliders) stay in sync when something OTHER
   * than the user dragging that exact control changed the values, such as
   * loading a saved project's flight condition back in. */
  sliderValues: SliderValues;
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
  /** See `MeshSource` -- `null` until the first mesh of this session loads. */
  private lastMeshSource: MeshSource | null = null;
  /** The latest `meshSummary` payload, kept around (in addition to being
   * emitted as an event) so a save-project action started well after the
   * summary fired -- e.g. after the user has since re-oriented an uploaded
   * mesh -- still has the CURRENT applied mapping/unit to persist. */
  private lastImportSummary: ImportSummary | null = null;
  private solveStartedAt = 0;
  /** The most recent (alpha, V) the Flight Condition panel has sent, cached
   * here (not owned by any one component) purely so the Solve panel's
   * "Solve Flow Field" button -- which has no other reason to know about
   * slider state -- can request a solve at the currently-displayed
   * condition without either panel needing a prop-drilled reference to
   * the other. */
  private lastSliderValues: SliderValues = { pitchDeg: 0, vInf: 15, cg: { x: 0, y: 0, z: 0 }, bankDeg: 0, yawDeg: 0 };

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
    this.streamlines = new Streamlines(rs.scene, rs.renderer);
    this.vorticityField = new VorticityField(rs.scene);
    this.contourPlane = new ContourPlane(rs.scene);
    this.applyVizState(this.vizState);

    const socket = new RekonSocket(resolveWsUrl("/ws"));
    this.socket = socket;
    socket.onStatus((status) => {
      this.wsStatus = status;
      this.emit("wsStatus", status);
    });

    socket.on(Tag.MeshGeometry, (buffer) => {
      // A fresh mesh should never inherit whatever attitude a previous
      // sweep animation left the group rotated to.
      this.setAttitudeDeg(0, 0, 0);
      this.lastSliderValues = { ...this.lastSliderValues, bankDeg: 0, pitchDeg: 0, yawDeg: 0 };
      const decoded = decodeMeshGeometry(buffer);
      const box = this.stlViewer!.setGeometry(decoded);
      this.focusCameraOn(box);
      this.emit("meshGeometry", decoded);
    });
    socket.on(Tag.MeshCleared, () => {
      this.setAttitudeDeg(0, 0, 0);
      this.lastSliderValues = { ...this.lastSliderValues, bankDeg: 0, pitchDeg: 0, yawDeg: 0 };
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

    startRenderLoop(rs, () => this.streamlines?.update());
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
    this.setAttitudeDeg(values.bankDeg, values.pitchDeg, values.yawDeg);
    this.emit("sliderValues", values);
    this.socket?.send(encodeSliderUpdate(values.pitchDeg, values.vInf, values.cg, values.bankDeg, values.yawDeg));
  }

  getLastSliderValues(): SliderValues {
    return this.lastSliderValues;
  }

  getWsStatus(): "connecting" | "open" | "closed" {
    return this.wsStatus;
  }

  getVizState(): VizState {
    return this.vizState;
  }

  getLastMeshSource(): MeshSource | null {
    return this.lastMeshSource;
  }

  getLastImportSummary(): ImportSummary | null {
    return this.lastImportSummary;
  }

  /** Rotates the RENDERED model to this attitude, client-side only -- no
   * network round trip, no re-solve (a full re-solve at a new attitude costs
   * a real panel-model rebuild, which only happens when `sendSlider` commits
   * a genuine bank/pitch/yaw change). Composes bank (about X), yaw (about
   * Y), and pitch (about Z) as `qBank * qYaw * qPitch`, matching
   * `rekon_geometry::Mesh::rotated_by_attitude`'s composition order exactly
   * -- the rendered model and the server's actual solved geometry must
   * always agree on what a given (bank, pitch, yaw) triple looks like. */
  setAttitudeDeg(bankDeg: number, pitchDeg: number, yawDeg: number) {
    if (this.bankGroup) {
      const qBank = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(bankDeg));
      const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yawDeg));
      const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(pitchDeg));
      this.bankGroup.quaternion.copy(qBank.multiply(qYaw).multiply(qPitch));
    }
    this.emit("attitudeDeg", { bankDeg, pitchDeg, yawDeg });
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
    // `frame.alphaDeg` is applied as a real PITCH rotation server-side now
    // (see `ws::bank_sweep`), so the rendered model must rotate to match --
    // yaw isn't part of this animation, so it stays at whatever it was.
    this.setAttitudeDeg(frame.bankDeg, frame.alphaDeg, this.lastSliderValues.yawDeg);
    this.lastSliderValues = { ...this.lastSliderValues, bankDeg: frame.bankDeg, pitchDeg: frame.alphaDeg };

    const sampler = new FieldSampler(frame);
    this.streamlines?.setField(sampler);
    this.contourPlane?.setField(sampler);
    this.vorticityField?.setField(frame);
    this.windTunnel?.setBounds(new THREE.Vector3(...frame.domainMin), new THREE.Vector3(...frame.domainMax));

    this.emit("panelResult", { cl: frame.cl, cdInduced: frame.cdInduced, cm: frame.cm, cp: frame.surfaceCp });
  }

  /** Solves at the currently-displayed flight condition (the Flight
   * Condition panel's last committed pitch/V/bank/yaw) unless overridden. */
  requestSolve(
    pitchDeg = this.lastSliderValues.pitchDeg,
    vInf = this.lastSliderValues.vInf,
    bankDeg = this.lastSliderValues.bankDeg,
    yawDeg = this.lastSliderValues.yawDeg,
  ) {
    this.solveStartedAt = performance.now();
    this.emit("solveStarted", undefined);
    const { resolutionMultiplier, maxSteps } = this.vizState.solveQuality;
    this.socket?.send(encodeSolveFlowFieldRequest(pitchDeg, vInf, bankDeg, yawDeg, resolutionMultiplier, maxSteps));
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
    // Merged onto the defaults (including the nested settings objects)
    // rather than trusted as complete -- a project saved before
    // `streamlineSettings`/`solveQuality` existed has no such keys in its
    // stored `viz_state` at all.
    this.vizState = {
      ...DEFAULT_VIZ_STATE,
      ...state,
      streamlineSettings: { ...DEFAULT_STREAMLINE_SETTINGS, ...state.streamlineSettings },
      solveQuality: { ...DEFAULT_SOLVE_QUALITY, ...state.solveQuality },
    };
    const merged = this.vizState;
    this.stlViewer?.setPressureVisible(merged.pressure);
    this.streamlines?.setVisible(merged.streamlines);
    this.vorticityField?.setVisible(merged.vorticity);
    this.contourPlane?.setVisible(merged.contour);
    this.streamlines?.setSeedPlane(merged.seedPlane, merged.planeAxis, merged.planePosition);
    this.contourPlane?.setSlice(merged.planeAxis, merged.planePosition);
    this.streamlines?.setStreamlineSettings(merged.streamlineSettings);
  }

  async importFile(file: File): Promise<ImportSummary> {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch(apiUrl("/api/mesh/import"), { method: "POST", body: formData });
    if (!response.ok) throw new Error(await response.text());
    const summary: ImportSummary = await response.json();
    this.lastMeshSource = { kind: "uploaded", file };
    this.lastImportSummary = summary;
    this.emit("meshSummary", summary);
    return summary;
  }

  async orientMesh(mapping: AxisMappingSummary, unit: string): Promise<ImportSummary> {
    const response = await fetch(apiUrl("/api/mesh/orient"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chord_axis: mapping.chord, up_axis: mapping.up, span_axis: mapping.span, unit }),
    });
    if (!response.ok) throw new Error(await response.text());
    const summary: ImportSummary = await response.json();
    // Re-orienting doesn't change WHICH file is uploaded, only the mapping/
    // unit applied to it -- `lastMeshSource` (the file itself) is untouched;
    // only the cached summary (which callers read the mapping back out of)
    // needs to move forward.
    this.lastImportSummary = summary;
    this.emit("meshSummary", summary);
    return summary;
  }

  async clearMesh(): Promise<void> {
    const response = await fetch(apiUrl("/api/mesh"), { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text());
    this.lastMeshSource = null;
    this.lastImportSummary = null;
  }

  /** Builds a wing mesh server-side from NACA + planform parameters (the
   * Airfoil Generator) and loads it as the current mesh -- same effect as
   * an STL import, no upload round-trip. */
  async generateWing(params: GenerateWingParams): Promise<ImportSummary> {
    const response = await fetch(apiUrl("/api/mesh/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!response.ok) throw new Error(await response.text());
    const summary: ImportSummary = await response.json();
    this.lastMeshSource = { kind: "generated", params };
    this.lastImportSummary = summary;
    this.emit("meshSummary", summary);
    return summary;
  }

  /** Loads one "Explore Models" catalog entry as the current mesh. */
  async loadSampleModel(id: string): Promise<ImportSummary> {
    const response = await fetch(apiUrl(`/api/models/${encodeURIComponent(id)}/load`), { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    const summary: ImportSummary = await response.json();
    this.lastMeshSource = { kind: "sample", sampleId: id };
    this.lastImportSummary = summary;
    this.emit("meshSummary", summary);
    return summary;
  }

  /** Only meaningful when running the desktop build's local server (a
   * hosted web deployment has no self-update path -- it's just redeployed).
   * Never throws: a check that fails (no release yet, offline) reads the
   * same as "no update available" -- see `rekon_app::updater`. */
  async getVersionInfo(): Promise<VersionInfo> {
    const response = await fetch(apiUrl("/api/version"));
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  /** Downloads and installs the latest release over the currently-running
   * exe. The process keeps running its OLD code in memory until it exits --
   * the caller must tell the user to relaunch afterward. */
  async applyUpdate(): Promise<{ version: string }> {
    const response = await fetch(apiUrl("/api/update/apply"), { method: "POST" });
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
