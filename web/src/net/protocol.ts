// Mirrors crates/rekon-protocol/src/tags.rs — keep both in sync.
// Wire format: [tag: u32 LE][payload: raw little-endian f32s]. The 4-byte tag keeps
// the payload 4-byte aligned, which `Float32Array(buffer, byteOffset)` requires
// (byteOffset must be a multiple of 4).

export const Tag = {
  LiveWave: 0x01,
  MeshGeometry: 0x11,
  MeshCleared: 0x12,
  SliderUpdate: 0x20,
  PanelResult: 0x21,
  PolarCurve: 0x22,
  TrimRequest: 0x23,
  TrimResult: 0x24,
  PolarRequest: 0x25,
  MultiBankSweepRequest: 0x40,
  MultiBankSweepFrame: 0x41,
  SolveFlowFieldRequest: 0x30,
  SolveProgress: 0x31,
  SolveResult: 0x32,
  SolveCancelledOrError: 0x33,
} as const;

export type TagValue = (typeof Tag)[keyof typeof Tag];

export interface DecodedFrame {
  tag: number;
  payload: Float32Array;
}

export interface DecodedMeshGeometry {
  tag: number;
  vertexCount: number;
  triangleCount: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

const HEADER_BYTES = 4;
const MESH_HEADER_BYTES = 12;

export function decodeFrame(buffer: ArrayBuffer): DecodedFrame {
  const tag = new DataView(buffer, 0, HEADER_BYTES).getUint32(0, true);
  const payload = new Float32Array(buffer, HEADER_BYTES);
  return { tag, payload };
}

// Mirrors rekon-protocol's encode_mesh_geometry: [tag][vertex_count][triangle_count]
// [positions f32*3*N][normals f32*3*N][indices u32*3*M]. Every section starts on a
// 4-byte boundary by construction, which typed-array byteOffsets require.
export function decodeMeshGeometry(buffer: ArrayBuffer): DecodedMeshGeometry {
  const header = new DataView(buffer, 0, MESH_HEADER_BYTES);
  const tag = header.getUint32(0, true);
  const vertexCount = header.getUint32(4, true);
  const triangleCount = header.getUint32(8, true);

  const positionsBytes = vertexCount * 3 * 4;
  const normalsBytes = vertexCount * 3 * 4;

  const positions = new Float32Array(buffer, MESH_HEADER_BYTES, vertexCount * 3);
  const normals = new Float32Array(buffer, MESH_HEADER_BYTES + positionsBytes, vertexCount * 3);
  const indices = new Uint32Array(
    buffer,
    MESH_HEADER_BYTES + positionsBytes + normalsBytes,
    triangleCount * 3,
  );

  return { tag, vertexCount, triangleCount, positions, normals, indices };
}

export interface DecodedPanelResult {
  cl: number;
  cdInduced: number;
  cm: number;
  /** Per-vertex Cp, same order/length as the current mesh's vertices. */
  cp: Float32Array;
}

// Mirrors rekon-app's ws/panel.rs encode_panel_result: a plain f32 frame
// (see decodeFrame) whose payload is [cl, cd_induced, cm, ...cp_per_vertex].
export function decodePanelResult(frame: DecodedFrame): DecodedPanelResult {
  return {
    cl: frame.payload[0],
    cdInduced: frame.payload[1],
    cm: frame.payload[2],
    cp: frame.payload.subarray(3),
  };
}

/** `bankDeg`, `pitchDeg` (what the UI calls "AoA"), and `yawDeg` are all REAL
 * geometric attitude angles (the model is rotated within a fixed-direction
 * wind tunnel), not a cheap freestream-only parameter like `vInf` -- see
 * `rekon-app`'s `panel::solve_panel_at_attitude` doc comment. The server
 * only pays for a full panel-model rebuild when the (bank, pitch, yaw)
 * TUPLE actually CHANGES between messages, so it's safe to always send the
 * current attitude here even while the user is only dragging V/CG. */
export function encodeSliderUpdate(
  pitchDeg: number,
  vInf: number,
  cg: { x: number; y: number; z: number },
  bankDeg: number,
  yawDeg: number,
): ArrayBuffer {
  return encodeF32Frame(Tag.SliderUpdate, new Float32Array([pitchDeg, vInf, cg.x, cg.y, cg.z, bankDeg, yawDeg]));
}

/** `resolutionMultiplier`/`maxSteps` control the LBM solve's grid density and
 * step count (see the Settings menu's "Flow solve quality" section) -- the
 * server clamps both regardless of what's sent here, so an out-of-range
 * value just gets pulled back in rather than rejected. */
export function encodeSolveFlowFieldRequest(
  pitchDeg: number,
  vInf: number,
  bankDeg: number,
  yawDeg: number,
  resolutionMultiplier: number,
  maxSteps: number,
): ArrayBuffer {
  return encodeF32Frame(Tag.SolveFlowFieldRequest, new Float32Array([pitchDeg, vInf, bankDeg, yawDeg, resolutionMultiplier, maxSteps]));
}

/** Requests a trim search (Cm(alpha)=0) about the current slider CG/V.
 * `bracket` overrides the server's default alpha search range if given. */
export function encodeTrimRequest(bracket?: { alphaLoDeg: number; alphaHiDeg: number }): ArrayBuffer {
  const payload = bracket ? new Float32Array([bracket.alphaLoDeg, bracket.alphaHiDeg]) : new Float32Array(0);
  return encodeF32Frame(Tag.TrimRequest, payload);
}

export type DecodedTrimResult =
  | { ok: true; alphaDeg: number; cl: number; cm: number; staticMargin: number }
  | { ok: false; alphaLoDeg: number; cmLo: number; alphaHiDeg: number; cmHi: number };

// Mirrors rekon-app's ws/panel.rs encode_trim_result: [1.0, alpha_deg, cl, cm,
// static_margin] on success, or [0.0, alpha_lo, cm_lo, alpha_hi, cm_hi] if no
// trim point was found in the search bracket.
export function decodeTrimResult(frame: DecodedFrame): DecodedTrimResult {
  const p = frame.payload;
  if (p[0] !== 0) {
    return { ok: true, alphaDeg: p[1], cl: p[2], cm: p[3], staticMargin: p[4] };
  }
  return { ok: false, alphaLoDeg: p[1], cmLo: p[2], alphaHiDeg: p[3], cmHi: p[4] };
}

export function encodePolarRequest(alphaMinDeg: number, alphaMaxDeg: number, nPoints: number): ArrayBuffer {
  return encodeF32Frame(Tag.PolarRequest, new Float32Array([alphaMinDeg, alphaMaxDeg, nPoints]));
}

export interface PolarPoint {
  alphaDeg: number;
  cl: number;
  cdInduced: number;
  cm: number;
}

// Mirrors rekon-app's ws/panel.rs encode_polar_curve: [n_points, alpha_0,
// cl_0, cd_induced_0, cm_0, alpha_1, ...].
export function decodePolarCurve(frame: DecodedFrame): PolarPoint[] {
  const n = frame.payload[0];
  const points: PolarPoint[] = [];
  for (let i = 0; i < n; i++) {
    const o = 1 + i * 4;
    points.push({ alphaDeg: frame.payload[o], cl: frame.payload[o + 1], cdInduced: frame.payload[o + 2], cm: frame.payload[o + 3] });
  }
  return points;
}

/** Requests a "banked flight" animation: `nFrames` discrete frames sweeping
 * alpha and bank together, each one a REAL re-solve (fresh panel-method
 * factorization + a full LBM run) on the mesh rotated to that frame's bank
 * angle -- not a cosmetic render-time rotation. Genuinely expensive by
 * design; frames stream back one at a time as `MultiBankSweepFrame`s,
 * possibly well apart in time, each preceded by its own `SolveProgress`
 * stream (same tag/shape the on-demand single solve uses). */
export function encodeMultiBankSweepRequest(
  alphaMinDeg: number,
  alphaMaxDeg: number,
  bankMinDeg: number,
  bankMaxDeg: number,
  nFrames: number,
): ArrayBuffer {
  return encodeF32Frame(Tag.MultiBankSweepRequest, new Float32Array([alphaMinDeg, alphaMaxDeg, bankMinDeg, bankMaxDeg, nFrames]));
}

export interface MultiBankSweepFrame {
  frameIndex: number;
  nFrames: number;
  alphaDeg: number;
  bankDeg: number;
  cl: number;
  cdInduced: number;
  cm: number;
  velDims: [number, number, number];
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** Per-vertex Cp (LBM-derived, same convention as `DecodedSolveResult.surfaceCp`). */
  surfaceCp: Float32Array;
  /** vx,vy,vz interleaved, flattened x + nx*(y + ny*z) over velDims (lattice units). */
  velocity: Float32Array;
}

// Mirrors rekon-app's ws/bank_sweep.rs encode_frame: [frame_index, n_frames,
// alpha_deg, bank_deg, cl, cd_induced, cm, n_vertices, vel_nx, vel_ny, vel_nz,
// domain_min(3), domain_max(3), surface_cp[per-vertex], velocity[3*nx*ny*nz]].
export function decodeMultiBankSweepFrame(frame: DecodedFrame): MultiBankSweepFrame {
  const p = frame.payload;
  const nVertices = p[7];
  const nx = p[8];
  const ny = p[9];
  const nz = p[10];
  const cpStart = 17;
  const cpEnd = cpStart + nVertices;
  return {
    frameIndex: p[0],
    nFrames: p[1],
    alphaDeg: p[2],
    bankDeg: p[3],
    cl: p[4],
    cdInduced: p[5],
    cm: p[6],
    velDims: [nx, ny, nz],
    domainMin: [p[11], p[12], p[13]],
    domainMax: [p[14], p[15], p[16]],
    surfaceCp: p.subarray(cpStart, cpEnd),
    velocity: p.subarray(cpEnd, cpEnd + nx * ny * nz * 3),
  };
}

export interface DecodedSolveProgress {
  step: number;
  maxSteps: number;
  maxVelocity: number;
  meanDensity: number;
}

// Mirrors rekon-app's ws/lbm.rs run_solve progress payload: [step, max_steps, max_velocity, mean_density].
export function decodeSolveProgress(frame: DecodedFrame): DecodedSolveProgress {
  return {
    step: frame.payload[0],
    maxSteps: frame.payload[1],
    maxVelocity: frame.payload[2],
    meanDensity: frame.payload[3],
  };
}

export interface DecodedSolveResult {
  velDims: [number, number, number];
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** Per-vertex Cp, same order/length as the current mesh's vertices. */
  surfaceCp: Float32Array;
  /** vx,vy,vz interleaved, flattened x + nx*(y + ny*z) over velDims (lattice units). */
  velocity: Float32Array;
}

const SOLVE_RESULT_HEADER_BYTES = 44;

// Mirrors rekon-protocol's encode_solve_result: [tag][vertex_count][vel_nx][vel_ny][vel_nz]
// [domain_min f32*3][domain_max f32*3][surface_cp f32*vertex_count][velocity f32*3*nx*ny*nz].
export function decodeSolveResult(buffer: ArrayBuffer): DecodedSolveResult {
  const header = new DataView(buffer, 0, SOLVE_RESULT_HEADER_BYTES);
  const vertexCount = header.getUint32(4, true);
  const nx = header.getUint32(8, true);
  const ny = header.getUint32(12, true);
  const nz = header.getUint32(16, true);
  const domainMin: [number, number, number] = [header.getFloat32(20, true), header.getFloat32(24, true), header.getFloat32(28, true)];
  const domainMax: [number, number, number] = [header.getFloat32(32, true), header.getFloat32(36, true), header.getFloat32(40, true)];

  const cpBytes = vertexCount * 4;
  const surfaceCp = new Float32Array(buffer, SOLVE_RESULT_HEADER_BYTES, vertexCount);
  const velocity = new Float32Array(buffer, SOLVE_RESULT_HEADER_BYTES + cpBytes, nx * ny * nz * 3);

  return { velDims: [nx, ny, nz], domainMin, domainMax, surfaceCp, velocity };
}

export function encodeF32Frame(tag: number, payload: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES + payload.byteLength);
  new DataView(buffer, 0, HEADER_BYTES).setUint32(0, tag, true);
  new Float32Array(buffer, HEADER_BYTES).set(payload);
  return buffer;
}
