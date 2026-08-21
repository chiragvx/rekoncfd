import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";

import { AxisGizmo } from "./axisGizmo";

export interface RekonScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: TrackballControls;
  /** The ground reference grid -- exposed so the viewport toolbar can toggle
   * it independent of everything else in the scene. */
  grid: THREE.GridHelper;
  /** (Re-)parents the renderer's canvas into `container` and syncs camera/
   * renderer/controls sizing to it, then keeps tracking that container's
   * size going forward.
   *
   * Must be safe to call more than once, into a DIFFERENT container each
   * time: `scene`/`camera`/`renderer`/`controls` are a page-persistent
   * singleton (see `RekonEngine.mount`), but the container element is not
   * -- every time client-side routing away from `/tool` and back remounts
   * `Viewport`, React hands it a brand-new `<div>`. Without re-parenting,
   * the canvas stays attached to the PREVIOUS (now-removed-from-the-
   * document) container, so the "new" tool page visit renders nothing at
   * all -- which reads as "the 3D view / rotation is completely broken",
   * not as a sizing glitch.
   */
  attachTo(container: HTMLElement): void;
}

export function createScene(container: HTMLElement): RekonScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e13);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(6, 5, 8);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);

  // TrackballControls, not OrbitControls: OrbitControls anchors orbiting to a
  // fixed world-up vector, so it can only orbit in 2 DOF (azimuth around Y,
  // elevation) and can never roll the view around the model's own flow axis
  // (X) -- exactly the "rotate around X" motion needed to inspect a wing
  // from underneath/above by spinning around its own fuselage line rather
  // than pitching the camera over the top. Trackball has no fixed up-vector,
  // so free-drag rotation naturally includes that roll.
  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 2.0;
  controls.zoomSpeed = 1.2;
  controls.panSpeed = 0.5;

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(5, 10, 7);
  scene.add(key);

  const grid = new THREE.GridHelper(20, 20, 0x1c2b3a, 0x141b24);
  scene.add(grid);

  let resizeObserver: ResizeObserver | null = null;

  function syncSize(el: HTMLElement) {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    // Unlike OrbitControls, Trackball tracks the element's screen-space
    // rect for its pointer math (see TrackballControls.handleResize) and
    // needs telling explicitly whenever it changes -- including right after
    // re-parenting, since its very first measurement (taken at construction
    // time, against whatever container existed then) is otherwise stale.
    controls.handleResize();
  }

  function attachTo(newContainer: HTMLElement) {
    if (renderer.domElement.parentElement !== newContainer) {
      newContainer.appendChild(renderer.domElement);
    }

    resizeObserver?.disconnect();
    // A ResizeObserver on the container (not a window "resize" listener):
    // the viewport's own size changes for reasons that never touch the
    // window -- a sidebar collapsing/expanding, or a panel width changing --
    // so window-level resize events alone would miss most real resizes here.
    resizeObserver = new ResizeObserver(() => syncSize(newContainer));
    resizeObserver.observe(newContainer);

    syncSize(newContainer);
  }

  attachTo(container);

  return { scene, camera, renderer, controls, grid, attachTo };
}

export function startRenderLoop(rs: RekonScene, onFrame?: (dt: number) => void) {
  const gizmo = new AxisGizmo();
  const timer = new THREE.Timer();
  timer.connect(document);
  function tick() {
    timer.update();
    const dt = timer.getDelta();
    onFrame?.(dt);
    rs.controls.update();
    rs.renderer.render(rs.scene, rs.camera);
    gizmo.render(rs.renderer, rs.camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
