import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";

export interface RekonScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: TrackballControls;
}

export function createScene(container: HTMLElement): RekonScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e13);

  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    1000,
  );
  camera.position.set(6, 5, 8);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

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

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Unlike OrbitControls, Trackball tracks the element's screen-space
    // rect for its pointer math and needs telling explicitly when it changes.
    controls.handleResize();
  });

  return { scene, camera, renderer, controls };
}

export function startRenderLoop(rs: RekonScene, onFrame?: (dt: number) => void) {
  const timer = new THREE.Timer();
  timer.connect(document);
  function tick() {
    timer.update();
    const dt = timer.getDelta();
    onFrame?.(dt);
    rs.controls.update();
    rs.renderer.render(rs.scene, rs.camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
