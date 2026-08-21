/// Encodes a tagged binary frame: `[tag: u32 LE][payload: raw little-endian f32s]`.
/// The 4-byte tag keeps the payload 4-byte aligned for both `bytemuck` on the Rust
/// side and `Float32Array(buffer, 4)` on the browser side. No serde on this path —
/// the payload is a direct `bytemuck` byte-cast, not a serialized form.
pub fn encode_f32_frame(tag: u32, payload: &[f32]) -> Vec<u8> {
    let payload_bytes: &[u8] = bytemuck::cast_slice(payload);
    let mut frame = Vec::with_capacity(4 + payload_bytes.len());
    frame.extend_from_slice(&tag.to_le_bytes());
    frame.extend_from_slice(payload_bytes);
    frame
}

/// Encodes a `MeshGeometry` frame:
/// `[tag: u32][vertex_count: u32][triangle_count: u32][positions: f32*3*vertex_count]
///  [normals: f32*3*vertex_count][indices: u32*3*triangle_count]`.
/// Every section starts on a 4-byte boundary (each section's byte length is a
/// multiple of 4 by construction), which both `bytemuck` and the browser's
/// typed-array views over the ArrayBuffer require.
pub fn encode_mesh_geometry(tag: u32, positions: &[f32], normals: &[f32], indices: &[u32]) -> Vec<u8> {
    assert_eq!(positions.len(), normals.len(), "one normal per position component");
    assert_eq!(positions.len() % 3, 0, "positions must be flat xyz triples");
    assert_eq!(indices.len() % 3, 0, "indices must be flat triangle triples");

    let vertex_count = (positions.len() / 3) as u32;
    let triangle_count = (indices.len() / 3) as u32;

    let mut frame = Vec::with_capacity(
        12 + positions.len() * 4 + normals.len() * 4 + indices.len() * 4,
    );
    frame.extend_from_slice(&tag.to_le_bytes());
    frame.extend_from_slice(&vertex_count.to_le_bytes());
    frame.extend_from_slice(&triangle_count.to_le_bytes());
    frame.extend_from_slice(bytemuck::cast_slice(positions));
    frame.extend_from_slice(bytemuck::cast_slice(normals));
    frame.extend_from_slice(bytemuck::cast_slice(indices));
    frame
}

/// Encodes a `SolveResult` frame:
/// `[tag: u32][vertex_count: u32][vel_nx: u32][vel_ny: u32][vel_nz: u32]
///  [domain_min: f32*3][domain_max: f32*3][surface_cp: f32*vertex_count]
///  [velocity: f32*3*vel_nx*vel_ny*vel_nz]` (velocity interleaved vx,vy,vz per cell,
/// flattened `x + nx*(y + ny*z)`). The 20-byte integer header plus 24 bytes of
/// domain bounds keeps every subsequent f32 section 4-byte aligned.
#[allow(clippy::too_many_arguments)]
pub fn encode_solve_result(
    tag: u32,
    surface_cp: &[f32],
    vel_dims: (u32, u32, u32),
    domain_min: [f32; 3],
    domain_max: [f32; 3],
    velocity: &[f32],
) -> Vec<u8> {
    let (nx, ny, nz) = vel_dims;
    assert_eq!(velocity.len() as u64, nx as u64 * ny as u64 * nz as u64 * 3, "velocity must be nx*ny*nz*3 interleaved floats");

    let mut frame = Vec::with_capacity(44 + surface_cp.len() * 4 + velocity.len() * 4);
    frame.extend_from_slice(&tag.to_le_bytes());
    frame.extend_from_slice(&(surface_cp.len() as u32).to_le_bytes());
    frame.extend_from_slice(&nx.to_le_bytes());
    frame.extend_from_slice(&ny.to_le_bytes());
    frame.extend_from_slice(&nz.to_le_bytes());
    frame.extend_from_slice(bytemuck::cast_slice(&domain_min));
    frame.extend_from_slice(bytemuck::cast_slice(&domain_max));
    frame.extend_from_slice(bytemuck::cast_slice(surface_cp));
    frame.extend_from_slice(bytemuck::cast_slice(velocity));
    frame
}
