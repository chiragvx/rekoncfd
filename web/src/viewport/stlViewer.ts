import * as THREE from "three";

import type { DecodedMeshGeometry } from "../net/protocol";
import { applyNeutralColor, applyPressureColors } from "../viz/pressureColormap";

/** Renders the currently-imported wing mesh; replaces itself wholesale on each new import. */
export class StlViewer {
  private readonly scene: THREE.Scene;
  private mesh: THREE.Mesh | null = null;
  private lastCp: Float32Array | null = null;
  private pressureVisible = true;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setGeometry(decoded: DecodedMeshGeometry): THREE.Box3 {
    this.dispose();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(decoded.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(decoded.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(decoded.indices, 1));
    // Neutral placeholder colors until the first PanelResult arrives.
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(decoded.vertexCount * 3).fill(0.85), 3));

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.05,
      roughness: 0.65,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.mesh);

    geometry.computeBoundingBox();
    return geometry.boundingBox ?? new THREE.Box3();
  }

  /** Recolors the current mesh's surface from per-vertex Cp values (or just
   * stores it for later if the pressure overlay is currently toggled off).
   * No-op if no mesh is loaded yet. */
  setPressure(cp: Float32Array) {
    if (!this.mesh) return;
    this.lastCp = cp;
    if (this.pressureVisible) {
      applyPressureColors(this.mesh.geometry, cp);
    }
  }

  /** Toggles the Cp colormap on/off, reverting to a neutral gray when off
   * rather than hiding the mesh entirely -- other overlays (streamlines,
   * vorticity hotspots) still want the surface visible as a spatial
   * reference even with pressure coloring off. */
  setPressureVisible(visible: boolean) {
    this.pressureVisible = visible;
    if (!this.mesh) return;
    if (visible && this.lastCp) {
      applyPressureColors(this.mesh.geometry, this.lastCp);
    } else if (!visible) {
      applyNeutralColor(this.mesh.geometry);
    }
  }

  dispose() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh = null;
    this.lastCp = null;
  }
}
