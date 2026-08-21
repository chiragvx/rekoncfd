import * as THREE from "three";

/** Wireframe box marking the wind-tunnel domain the wing sits inside, plus a
 * flow-direction arrow at the -X inlet face and a small axis triad -- both
 * exist so the always-fixed X=flow/Y=up/Z=span convention (not obvious once
 * a mesh can be re-oriented after import) stays visible in the viewport. */
export class WindTunnel {
  private readonly group: THREE.Group;
  private box: THREE.LineSegments | null = null;
  private flowArrow: THREE.ArrowHelper | null = null;
  private axisTriad: THREE.AxesHelper | null = null;

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
  }

  /** Removes the box/arrow/triad without replacing them -- used when there's
   * no mesh (and so no domain) to show bounds for anymore. */
  clear() {
    if (this.box) {
      this.group.remove(this.box);
      this.box.geometry.dispose();
      (this.box.material as THREE.Material).dispose();
      this.box = null;
    }
    if (this.flowArrow) {
      this.group.remove(this.flowArrow);
      this.flowArrow.dispose();
      this.flowArrow = null;
    }
    if (this.axisTriad) {
      this.group.remove(this.axisTriad);
      this.axisTriad.dispose();
      this.axisTriad = null;
    }
  }

  /** Toggling the persistent `group` (not recreating it) means this survives
   * `clear()`/`setBounds()` cycles (mesh clear, re-import) without needing
   * separate bookkeeping -- whoever owns the toggle just calls this again
   * whenever they want. */
  setVisible(visible: boolean) {
    this.group.visible = visible;
  }

  setBounds(min: THREE.Vector3, max: THREE.Vector3) {
    this.clear();

    const size = new THREE.Vector3().subVectors(max, min);
    const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);

    const geometry = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(size.x, size.y, size.z),
    );
    const material = new THREE.LineBasicMaterial({ color: 0x2c4258, transparent: true, opacity: 0.6 });
    this.box = new THREE.LineSegments(geometry, material);
    this.box.position.copy(center);
    this.group.add(this.box);

    // Flow arrow: starts a bit upstream of the -X inlet face, points +X
    // (the fixed flow direction), sized relative to the domain's own span.
    const arrowLength = Math.max(size.x * 0.25, 0.05);
    const inletOrigin = new THREE.Vector3(min.x - arrowLength * 1.2, center.y, center.z);
    this.flowArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      inletOrigin,
      arrowLength,
      0x6fb3ff,
      arrowLength * 0.3,
      arrowLength * 0.2,
    );
    this.group.add(this.flowArrow);

    // Small axis triad anchored at the same inlet corner, for an
    // unambiguous X/Y/Z reference regardless of camera angle.
    const triadSize = Math.max(size.length() * 0.08, 0.05);
    this.axisTriad = new THREE.AxesHelper(triadSize);
    this.axisTriad.position.set(min.x, min.y, min.z);
    this.group.add(this.axisTriad);
  }
}
