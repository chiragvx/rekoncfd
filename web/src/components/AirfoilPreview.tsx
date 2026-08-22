import { useEffect, useRef } from "react";

import { sampleAirfoil, type PreviewAirfoil } from "@/lib/airfoilPreview";

/** Shared with `airfoilExport.ts`'s PNG export, so the on-page preview and
 * the exported image are always pixel-for-pixel the same drawing, just at a
 * different canvas resolution. */
export function drawAirfoilToCanvas(
  ctx: CanvasRenderingContext2D,
  airfoil: PreviewAirfoil,
  width: number,
  height: number,
  accentColor: string,
) {
  ctx.clearRect(0, 0, width, height);

  const { upper, lower } = sampleAirfoil(airfoil, 100);

  const pad = 16;
  const scale = (width - pad * 2) * 0.92;
  const originX = pad + (width - pad * 2 - scale) / 2;
  const originY = height / 2;
  const toScreen = ([x, y]: [number, number]) => [originX + x * scale, originY - y * scale] as const;

  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(originX + scale, originY);
  ctx.stroke();

  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  upper.forEach((p, i) => {
    const [sx, sy] = toScreen(p);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  for (let i = lower.length - 1; i >= 0; i--) {
    const [sx, sy] = toScreen(lower[i]);
    ctx.lineTo(sx, sy);
  }
  ctx.closePath();
  ctx.fillStyle = "color-mix(in srgb, " + accentColor + " 14%, transparent)";
  ctx.fill();
  ctx.stroke();
}

export function AirfoilPreview({ airfoil }: { airfoil: PreviewAirfoil }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const style = getComputedStyle(canvas);
    const accent = style.getPropertyValue("--color-primary")?.trim() || "#6fb3ff";

    drawAirfoilToCanvas(ctx, airfoil, width, height, accent);
  }, [airfoil]);

  return <canvas ref={canvasRef} className="text-foreground h-40 w-full rounded-md" />;
}
