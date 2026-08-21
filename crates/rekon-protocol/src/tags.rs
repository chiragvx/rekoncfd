//! Single source of truth for the binary WebSocket message-type tags.
//! Keep `web/src/net/protocol.ts` in sync — see the round-trip test in this crate.
//!
//! Tags are 4 bytes (little-endian u32), not 1, so the f32 payload that follows
//! stays 4-byte aligned — `Float32Array(buffer, byteOffset)` on the browser side
//! requires `byteOffset` to be a multiple of 4, and a 1-byte tag would violate that.

pub const LIVE_WAVE: u32 = 0x01;

pub const MESH_GEOMETRY: u32 = 0x11;
/// Empty payload -- tells a connected client the mesh was cleared server-side
/// (`DELETE /api/mesh`), so it should reset its viewport/UI back to the
/// no-mesh-loaded state rather than keep showing whatever it last rendered.
pub const MESH_CLEARED: u32 = 0x12;

pub const SLIDER_UPDATE: u32 = 0x20;
pub const PANEL_RESULT: u32 = 0x21;
/// Server -> client, sent in response to `POLAR_REQUEST`. Payload:
/// `[n_points, alpha_0, cl_0, cd_induced_0, cm_0, alpha_1, cl_1, ...]`.
pub const POLAR_CURVE: u32 = 0x22;
/// Client -> server: run a trim search (`Cm(alpha) = 0`) about the current
/// slider CG, bracketing `[alpha_lo_deg, alpha_hi_deg]`. Empty payload uses
/// the server's default bracket.
pub const TRIM_REQUEST: u32 = 0x23;
/// Server -> client, sent in response to `TRIM_REQUEST`. Payload:
/// `[1.0, alpha_deg, cl, cm, static_margin]` on success, or
/// `[0.0, alpha_lo_deg, cm_lo, alpha_hi_deg, cm_hi]` if the bracket doesn't
/// contain a sign change (no trim point found).
pub const TRIM_RESULT: u32 = 0x24;
/// Client -> server: run a polar sweep about the current slider CG/V.
/// Payload: `[alpha_min_deg, alpha_max_deg, n_points]`.
pub const POLAR_REQUEST: u32 = 0x25;

pub const SOLVE_FLOW_FIELD_REQUEST: u32 = 0x30;
pub const SOLVE_PROGRESS: u32 = 0x31;
pub const SOLVE_RESULT: u32 = 0x32;
pub const SOLVE_CANCELLED_OR_ERROR: u32 = 0x33;
