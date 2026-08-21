import * as THREE from "three";

const AXES: { dir: THREE.Vector3; color: number; label: string }[] = [
  { dir: new THREE.Vector3(1, 0, 0), color: 0xff5f5f, label: "X" },
  { dir: new THREE.Vector3(0, 1, 0), color: 0x7be0a8, label: "Y" },
  { dir: new THREE.Vector3(0, 0, 1), color: 0x6fb3ff, label: "Z" },
];

const GIZMO_SIZE_PX = 92;
const GIZMO_MARGIN_PX = 16;
const AXIS_LENGTH = 1;

function labelSprite(text: string, hexColor: string): THREE.Sprite {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  ctx.fillStyle = hexColor;
  ctx.fill();

  ctx.fillStyle = "#0b0e13";
  ctx.font = "700 30px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(0.42, 0.42, 1);
  return sprite;
}

function negativeEndSprite(hexColor: string): THREE.Sprite {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = hexColor;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(0.3, 0.3, 1);
  return sprite;
}

/** Small picture-in-picture axis reference gizmo, rendered into the bottom-
 * right corner of the same canvas via a scissored sub-viewport. A persistent,
 * unambiguous "which way is X/Y/Z" reference that rotates in sync with the
 * main camera -- re-orientable STL imports plus a free trackball camera
 * (which has no fixed up-vector) otherwise make this wind tunnel's fixed
 * X=flow/Y=up/Z=span convention easy to lose track of once you've rotated
 * away from the default view. Colors match the small `AxesHelper` triad
 * `WindTunnel` already draws at the domain corner (three.js's own default
 * X=red/Y=green/Z=blue), so the two never disagree. */
export class AxisGizmo {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10);

  constructor() {
    for (const axis of AXES) {
      const color = new THREE.Color(axis.color);
      const hex = `#${color.getHexString()}`;
      const tip = axis.dir.clone().multiplyScalar(AXIS_LENGTH);

      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), tip]),
        new THREE.LineBasicMaterial({ color, depthTest: false }),
      );
      this.scene.add(line);

      const label = labelSprite(axis.label, hex);
      label.position.copy(tip).multiplyScalar(1.32);
      this.scene.add(label);

      const negativeEnd = negativeEndSprite(hex);
      negativeEnd.position.copy(tip).multiplyScalar(-1.15);
      this.scene.add(negativeEnd);
    }
  }

  /** Renders the gizmo, oriented to match `mainCamera`'s current view
   * direction. Must run AFTER the main scene render in the same frame (it
   * clears depth so it's never occluded by the model), and restores the
   * renderer's full viewport/scissor before returning so the NEXT frame's
   * main-scene render isn't left clipped to the gizmo's small corner rect.
   * All units are logical (CSS) pixels -- `WebGLRenderer.setViewport`/
   * `setScissor` apply the device pixel ratio internally, same as `getSize`. */
  render(renderer: THREE.WebGLRenderer, mainCamera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    const x = size.x - GIZMO_SIZE_PX - GIZMO_MARGIN_PX;
    const y = GIZMO_MARGIN_PX; // viewport/scissor Y origin is the BOTTOM edge

    // Fixed distance from the origin, looking back at it from whatever
    // angle the main camera is currently oriented at -- an orbit gizmo, not
    // a copy of the main camera's actual position/zoom.
    const viewDir = new THREE.Vector3();
    mainCamera.getWorldDirection(viewDir);
    this.camera.position.copy(viewDir).multiplyScalar(-4);
    this.camera.up.copy(mainCamera.up);
    this.camera.lookAt(0, 0, 0);

    renderer.setScissorTest(true);
    renderer.setViewport(x, y, GIZMO_SIZE_PX, GIZMO_SIZE_PX);
    renderer.setScissor(x, y, GIZMO_SIZE_PX, GIZMO_SIZE_PX);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
  }
}
