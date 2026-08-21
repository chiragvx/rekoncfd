/// Splits a tagged binary frame back into `(tag, payload)`. Mirrors `encode_f32_frame`.
/// Used by this crate's round-trip test; the frontend has its own decoder in `web/src/net/protocol.ts`.
///
/// Decodes payload floats via explicit `from_le_bytes` chunks rather than a `bytemuck`
/// slice-cast: a byte slice sourced from an arbitrary offset has no compile-time alignment
/// guarantee, so this avoids relying on incidental allocator alignment.
pub fn decode_f32_frame(frame: &[u8]) -> Option<(u32, Vec<f32>)> {
    if frame.len() < 4 {
        return None;
    }
    let (tag_bytes, payload_bytes) = frame.split_at(4);
    let tag = u32::from_le_bytes(tag_bytes.try_into().ok()?);
    if payload_bytes.len() % 4 != 0 {
        return None;
    }
    let payload = payload_bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
        .collect();
    Some((tag, payload))
}

pub struct DecodedMeshGeometry {
    pub tag: u32,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
}

/// Mirrors `encode_mesh_geometry`. Used by this crate's round-trip test.
pub fn decode_mesh_geometry(frame: &[u8]) -> Option<DecodedMeshGeometry> {
    if frame.len() < 12 {
        return None;
    }
    let tag = u32::from_le_bytes(frame[0..4].try_into().ok()?);
    let vertex_count = u32::from_le_bytes(frame[4..8].try_into().ok()?) as usize;
    let triangle_count = u32::from_le_bytes(frame[8..12].try_into().ok()?) as usize;

    let positions_bytes = vertex_count * 3 * 4;
    let normals_bytes = vertex_count * 3 * 4;
    let indices_bytes = triangle_count * 3 * 4;

    let mut offset = 12;
    let positions_end = offset + positions_bytes;
    let normals_end = positions_end + normals_bytes;
    let indices_end = normals_end + indices_bytes;
    if frame.len() < indices_end {
        return None;
    }

    let positions = frame[offset..positions_end]
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    offset = positions_end;
    let normals = frame[offset..normals_end]
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    let indices = frame[normals_end..indices_end]
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect();

    Some(DecodedMeshGeometry { tag, positions, normals, indices })
}

pub struct DecodedSolveResult {
    pub tag: u32,
    pub vel_dims: (u32, u32, u32),
    pub domain_min: [f32; 3],
    pub domain_max: [f32; 3],
    pub surface_cp: Vec<f32>,
    pub velocity: Vec<f32>,
}

/// Mirrors `encode_solve_result`. Used by this crate's round-trip test.
pub fn decode_solve_result(frame: &[u8]) -> Option<DecodedSolveResult> {
    if frame.len() < 44 {
        return None;
    }
    let tag = u32::from_le_bytes(frame[0..4].try_into().ok()?);
    let vertex_count = u32::from_le_bytes(frame[4..8].try_into().ok()?) as usize;
    let nx = u32::from_le_bytes(frame[8..12].try_into().ok()?);
    let ny = u32::from_le_bytes(frame[12..16].try_into().ok()?);
    let nz = u32::from_le_bytes(frame[16..20].try_into().ok()?);

    let f32_at = |bytes: &[u8]| -> f32 { f32::from_le_bytes(bytes.try_into().unwrap()) };
    let domain_min = [f32_at(&frame[20..24]), f32_at(&frame[24..28]), f32_at(&frame[28..32])];
    let domain_max = [f32_at(&frame[32..36]), f32_at(&frame[36..40]), f32_at(&frame[40..44])];

    let cp_bytes = vertex_count * 4;
    let velocity_len = nx as usize * ny as usize * nz as usize * 3;
    let velocity_bytes = velocity_len * 4;

    let cp_start = 44;
    let cp_end = cp_start + cp_bytes;
    let vel_end = cp_end + velocity_bytes;
    if frame.len() < vel_end {
        return None;
    }

    let surface_cp = frame[cp_start..cp_end]
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    let velocity = frame[cp_end..vel_end]
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect();

    Some(DecodedSolveResult { tag, vel_dims: (nx, ny, nz), domain_min, domain_max, surface_cp, velocity })
}
