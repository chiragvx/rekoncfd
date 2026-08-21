pub mod decode;
pub mod encode;
pub mod tags;

pub use decode::{decode_f32_frame, decode_mesh_geometry, decode_solve_result, DecodedMeshGeometry, DecodedSolveResult};
pub use encode::{encode_f32_frame, encode_mesh_geometry, encode_solve_result};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f32_frame_round_trips() {
        let payload = [1.0_f32, -2.5, 3.25, 0.0];
        let frame = encode_f32_frame(tags::LIVE_WAVE, &payload);
        let (tag, decoded) = decode_f32_frame(&frame).expect("frame decodes");
        assert_eq!(tag, tags::LIVE_WAVE);
        assert_eq!(decoded, payload);
    }

    #[test]
    fn mesh_geometry_round_trips() {
        // A single triangle: 3 vertices, 1 triangle.
        let positions = [0.0_f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let normals = [0.0_f32, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let indices = [0_u32, 1, 2];

        let frame = encode_mesh_geometry(tags::MESH_GEOMETRY, &positions, &normals, &indices);
        let decoded = decode_mesh_geometry(&frame).expect("frame decodes");

        assert_eq!(decoded.tag, tags::MESH_GEOMETRY);
        assert_eq!(decoded.positions, positions);
        assert_eq!(decoded.normals, normals);
        assert_eq!(decoded.indices, indices);
    }

    #[test]
    fn solve_result_round_trips() {
        let surface_cp = [0.5_f32, -0.3, 1.0];
        let vel_dims = (2u32, 2, 1);
        let domain_min = [-1.0_f32, -0.5, -0.2];
        let domain_max = [1.0_f32, 0.5, 0.2];
        let velocity: Vec<f32> = (0..(2 * 2 * 1 * 3)).map(|i| i as f32 * 0.1).collect();

        let frame = encode_solve_result(tags::SOLVE_RESULT, &surface_cp, vel_dims, domain_min, domain_max, &velocity);
        let decoded = decode_solve_result(&frame).expect("frame decodes");

        assert_eq!(decoded.tag, tags::SOLVE_RESULT);
        assert_eq!(decoded.vel_dims, vel_dims);
        assert_eq!(decoded.domain_min, domain_min);
        assert_eq!(decoded.domain_max, domain_max);
        assert_eq!(decoded.surface_cp, surface_cp);
        assert_eq!(decoded.velocity, velocity);
    }
}
