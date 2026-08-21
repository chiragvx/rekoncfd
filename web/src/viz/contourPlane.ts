import * as THREE from "three";

import { FieldSampler, SliceAxis, speedColormap } from "./fieldSampler";

/** Texture resolution across the slice. Rebuilt only when the field or the
 * slice moves (never per frame), so this can be generous. */
const TEX_RES = 256;

/** A colormapped cut through the velocity field: the classic CFD "contour
 * plane". Renders the plane's speed magnitude as a texture on a quad, which
 * shows the wake's shape and extent far more directly than particles alone
 * -- particles only sample where they happen to travel, whereas this covers
 * the whole cut.
 *
 * Built entirely client-side from the velocity grid the solve already sends,
 * so no protocol or server change is involved. */
export class ContourPlane {
  private readonly scene: THREE.Scene;
  private mesh: THREE.Mesh | null = null;
  private sampler: FieldSampler | null = null;
  private visible = false;
  private axis: SliceAxis = SliceAxis.Z;
  private position01 = 0.5;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setField(sampler: FieldSampler) {
    this.sampler = sampler;
    this.rebuild();
  }

  setSlice(axis: SliceAxis, position01: number) {
    this.axis = axis;
    this.position01 = position01;
    this.rebuild();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (this.mesh) this.mesh.visible = visible;
  }

  private rebuild() {
    const s = this.sampler;
    if (!s) return;
    this.dispose();

    const coord = s.slicePlaneCoord(this.axis, this.position01);
    const size = s.domainSize;
    const min = s.domainMin;

    // Each case pairs a PlaneGeometry orientation with the (u,v) -> world
    // mapping that matches it, so the texture lines up with the geometry.
    // PlaneGeometry's local +X follows u and local +Y follows v; the
    // rotations below were chosen so v maps to an INCREASING world axis in
    // every case (a rotation of the opposite sign would mirror the image).
    let width: number;
    let height: number;
    let rotation: THREE.Euler;
    let toWorld: (u: number, v: number, out: THREE.Vector3) => void;
    const center = new THREE.Vector3();

    if (this.axis === SliceAxis.Z) {
      width = size.x;
      height = size.y;
      rotation = new THREE.Euler(0, 0, 0);
      center.set(min.x + size.x / 2, min.y + size.y / 2, coord);
      toWorld = (u, v, out) => out.set(min.x + u * size.x, min.y + v * size.y, coord);
    } else if (this.axis === SliceAxis.Y) {
      width = size.x;
      height = size.z;
      rotation = new THREE.Euler(Math.PI / 2, 0, 0);
      center.set(min.x + size.x / 2, coord, min.z + size.z / 2);
      toWorld = (u, v, out) => out.set(min.x + u * size.x, coord, min.z + v * size.z);
    } else {
      width = size.z;
      height = size.y;
      rotation = new THREE.Euler(0, -Math.PI / 2, 0);
      center.set(coord, min.y + size.y / 2, min.z + size.z / 2);
      toWorld = (u, v, out) => out.set(coord, min.y + v * size.y, min.z + u * size.z);
    }

    const data = new Uint8Array(TEX_RES * TEX_RES * 4);
    const p = new THREE.Vector3();
    const vel = new THREE.Vector3();
    const color = new THREE.Color();
    for (let py = 0; py < TEX_RES; py++) {
      for (let px = 0; px < TEX_RES; px++) {
        const u = (px + 0.5) / TEX_RES;
        const v = (py + 0.5) / TEX_RES;
        toWorld(u, v, p);
        s.sample(p.x, p.y, p.z, vel);
        speedColormap(vel.length() / s.speedScale, color);
        const o = (py * TEX_RES + px) * 4;
        data[o] = color.r * 255;
        data[o + 1] = color.g * 255;
        data[o + 2] = color.b * 255;
        data[o + 3] = 255;
      }
    }

    const texture = new THREE.DataTexture(data, TEX_RES, TEX_RES, THREE.RGBAFormat);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    const geometry = new THREE.PlaneGeometry(width, height);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      // The wing sits in the plane's path; without this the quad z-fights
      // against the surface where they intersect.
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(center);
    this.mesh.rotation.copy(rotation);
    this.mesh.visible = this.visible;
    // Draw after the opaque wing so blending composites correctly.
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);
  }

  dispose() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    const material = this.mesh.material as THREE.MeshBasicMaterial;
    material.map?.dispose();
    material.dispose();
    this.mesh = null;
  }
}
