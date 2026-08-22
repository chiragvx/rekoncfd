import { useEffect, useRef } from "react";
import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";

import { buildWingGeometry, type WingPreviewParams } from "@/lib/wingPreviewGeometry";

export function WingPreview3D({ params, wireframe }: { params: WingPreviewParams; wireframe: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);

  // Scene/camera/renderer/controls are a one-time setup per mount -- rebuilt
  // fresh each time this component mounts (unlike the main tool's
  // page-persistent scene) since this preview only exists while the
  // Airfoil Generator page is open.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e13);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.set(0.6, 0.5, 1.1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const controls = new TrackballControls(camera, renderer.domElement);
    controls.rotateSpeed = 3.0;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.4;
    controls.noPan = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(2, 3, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(-2, -1, -2);
    scene.add(fill);

    const material = new THREE.MeshStandardMaterial({
      color: 0x6fb3ff,
      metalness: 0.1,
      roughness: 0.6,
      side: THREE.DoubleSide,
      wireframe: false,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    scene.add(mesh);
    meshRef.current = mesh;

    function syncSize() {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      controls.handleResize();
    }
    syncSize();
    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(container);

    let raf = 0;
    function animate() {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      mesh.geometry.dispose();
      material.dispose();
      container.removeChild(renderer.domElement);
      meshRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuilds just the geometry whenever the wing's params change -- the
  // scene/camera/controls set up above stay untouched so rotating the view
  // while dragging a slider doesn't reset the camera.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const oldGeometry = mesh.geometry;
    mesh.geometry = buildWingGeometry(params);
    oldGeometry.dispose();

    // Recenter so the wing's root sits at the scene origin regardless of
    // planform size -- keeps the fixed camera framing reasonable across the
    // whole span/chord slider range.
    mesh.geometry.computeBoundingSphere();
    const sphere = mesh.geometry.boundingSphere;
    if (sphere) {
      mesh.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
    }
  }, [params]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    (mesh.material as THREE.MeshStandardMaterial).wireframe = wireframe;
  }, [wireframe]);

  return <div ref={containerRef} className="h-72 w-full rounded-md" />;
}
