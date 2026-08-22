import { useEffect, useRef } from "react";

const PARTICLE_COUNT = 130;
const U_INF = 70; // px/s freestream speed
// ~2.5s of history at 60fps -- long enough to read as a continuous flowing
// curve bending around the body, not a scatter of short dashes.
const TRAIL_LENGTH = 150;
const SQUASH = 2.4; // chord/thickness ratio of the obstacle ellipse

interface Particle {
  x: number;
  y: number;
  trail: number[]; // flat [x0,y0,x1,y1,...], newest last
}

/** The exact closed-form velocity field for 2D potential flow past a
 * cylinder of radius R in a freestream U (uniform flow + doublet),
 * evaluated in coordinates squashed by SQUASH so the circular solution
 * reads as a thin wing-like ellipse instead -- the same physics a real
 * panel method's far-field reduces to, not an arbitrary decorative curl.
 * Returns null inside/too near the body (no meaningful exterior velocity
 * there -- callers respawn the particle instead of rendering it). */
function velocityAt(dx: number, dy: number, R: number): { u: number; v: number } | null {
  const X = dx;
  const Y = dy * SQUASH;
  const r2 = X * X + Y * Y;
  if (r2 < R * R * 1.15) return null;
  const r4 = r2 * r2;
  const u = U_INF * (1 - (R * R * (X * X - Y * Y)) / r4);
  const v = (-U_INF * (R * R * (2 * X * Y)) / r4) / SQUASH;
  return { u, v };
}

export function HeroFlowField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    const cx = () => width * 0.52;
    const cy = () => height * 0.5;
    const R = () => Math.min(width, height) * 0.15;

    function spawn(atLeftEdge: boolean): Particle {
      const r = R();
      const y = cy() + (Math.random() - 0.5) * height * 0.9;
      const x = atLeftEdge ? -Math.random() * 60 : Math.random() * width;
      // Never spawn inside/too near the body.
      const dy = y - cy();
      const dx = x - cx();
      if (Math.abs(dx) < r * 2 && Math.abs(dy) < r / SQUASH) {
        return spawn(atLeftEdge);
      }
      return { x, y, trail: [] };
    }

    const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => spawn(false));

    function step(dt: number) {
      for (const p of particles) {
        const vel = velocityAt(p.x - cx(), p.y - cy(), R());
        if (!vel || p.x > width + 40) {
          const fresh = spawn(true);
          p.x = fresh.x;
          p.y = fresh.y;
          p.trail = [];
          continue;
        }
        p.x += vel.u * dt;
        p.y += vel.v * dt;
        p.trail.push(p.x, p.y);
        if (p.trail.length > TRAIL_LENGTH * 2) p.trail.splice(0, p.trail.length - TRAIL_LENGTH * 2);
      }
    }

    function drawBody() {
      const r = R();
      ctx!.save();
      ctx!.translate(cx(), cy());
      ctx!.scale(1, 1 / SQUASH);
      ctx!.beginPath();
      ctx!.arc(0, 0, r, 0, Math.PI * 2);
      ctx!.restore();
      const grad = ctx!.createLinearGradient(cx() - r, cy(), cx() + r, cy());
      grad.addColorStop(0, "rgba(111,179,255,0.22)");
      grad.addColorStop(0.5, "rgba(111,179,255,0.42)");
      grad.addColorStop(1, "rgba(111,179,255,0.15)");
      ctx!.fillStyle = grad;
      ctx!.fill();
      ctx!.strokeStyle = "rgba(111,179,255,0.6)";
      ctx!.lineWidth = 1;
      ctx!.stroke();
    }

    function frame(dt: number) {
      ctx!.clearRect(0, 0, width, height);
      step(dt);

      for (const p of particles) {
        const nPoints = p.trail.length / 2;
        if (nPoints < 4) continue;
        const speedNear = velocityAt(p.x - cx(), p.y - cy(), R());
        const speed = speedNear ? Math.hypot(speedNear.u, speedNear.v) / U_INF : 1;
        // Cp-style coloring: fast-moving (low pressure, over the body) reads
        // warm; near-freestream speed reads the brand blue -- same
        // convention the real tool's own pressure map uses.
        const hue = speed > 1.35 ? "255,150,120" : "111,179,255";
        const baseAlpha = Math.min(0.95, 0.35 + speed * 0.3);

        // Comet-tail fade: draw as short overlapping segments whose alpha
        // ramps from faint (oldest) to full (newest/head) -- a single
        // uniform-opacity path reads as a flat dash, not a flowing streamline.
        const segments = 10;
        const step = Math.max(1, Math.floor(nPoints / segments));
        for (let s = 0; s < segments; s++) {
          const startIdx = s * step;
          const endIdx = Math.min(nPoints - 1, startIdx + step);
          if (startIdx >= endIdx) continue;
          const t = s / (segments - 1);
          ctx!.beginPath();
          ctx!.moveTo(p.trail[startIdx * 2], p.trail[startIdx * 2 + 1]);
          for (let i = startIdx + 1; i <= endIdx; i++) {
            ctx!.lineTo(p.trail[i * 2], p.trail[i * 2 + 1]);
          }
          ctx!.strokeStyle = `rgba(${hue},${baseAlpha * (0.15 + 0.85 * t)})`;
          ctx!.lineWidth = 1.6;
          ctx!.stroke();
        }
      }

      drawBody();
    }

    if (reduceMotion) {
      // One settled frame, no animation loop -- advance a while off-screen
      // logically (many integration steps at once) so it doesn't read as
      // "frozen mid-motion" for anyone who'd rather not see continuous movement.
      for (let i = 0; i < 200; i++) step(1 / 60);
      frame(0);
      return () => window.removeEventListener("resize", resize);
    }

    let raf = 0;
    let last = performance.now();
    function loop(now: number) {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      frame(dt);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} />;
}
