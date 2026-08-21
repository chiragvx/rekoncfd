import { useEffect, useRef } from "react";

import { engine } from "@/lib/engine";

/** Mounts the Three.js renderer's canvas into a plain div. The engine (and
 * therefore the scene/renderer) is a module-level singleton that mounts
 * itself at most once -- see `RekonEngine.mount`'s own idempotency note --
 * so this component can remount (e.g. React StrictMode's double-invoke)
 * without creating a second WebGL context. */
export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) engine.mount(containerRef.current);
  }, []);

  return <div ref={containerRef} className="fixed inset-0" />;
}
