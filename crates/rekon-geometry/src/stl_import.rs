use std::io::{Read, Seek};

use glam::Vec3;
use thiserror::Error;

use crate::mesh::Mesh;

#[derive(Debug, Error)]
pub enum ImportError {
    #[error("failed to parse STL: {0}")]
    Parse(#[from] std::io::Error),
    #[error("STL contains no triangles")]
    Empty,
}

pub fn import_stl<R: Read + Seek>(reader: &mut R) -> Result<Mesh, ImportError> {
    let indexed = stl_io::read_stl(reader)?;
    if indexed.faces.is_empty() {
        return Err(ImportError::Empty);
    }

    let vertices = indexed
        .vertices
        .iter()
        .map(|v| Vec3::new(v[0], v[1], v[2]))
        .collect();
    let triangles = indexed
        .faces
        .iter()
        .map(|f| [f.vertices[0] as u32, f.vertices[1] as u32, f.vertices[2] as u32])
        .collect();

    Ok(Mesh { vertices, triangles })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn imports_ascii_stl_tetrahedron() {
        let ascii = b"solid tet
facet normal 0 0 0
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
facet normal 0 0 0
  outer loop
    vertex 0 0 0
    vertex 0 1 0
    vertex 0 0 1
  endloop
endfacet
endsolid tet";
        let mut cursor = Cursor::new(ascii.to_vec());
        let mesh = import_stl(&mut cursor).expect("parses");
        assert_eq!(mesh.triangles.len(), 2);
        // 4 unique corners across both triangles; (0,0,0) and (0,1,0) are shared and
        // stl_io's exact-match vertex dedup (used by as_indexed_triangles) catches those.
        assert_eq!(mesh.vertices.len(), 4);
    }
}
