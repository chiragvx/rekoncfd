import { useEffect, useRef } from "react";

import { drawPolarSeries } from "@/lib/polarChart";

const WIDTH = 232;
const HEIGHT = 72;

export function PolarChart({
  label,
  xs,
  ys,
  color,
  trimAlphaDeg,
}: {
  label: string;
  xs: number[];
  ys: number[];
  color: string;
  trimAlphaDeg?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    drawPolarSeries(canvasRef.current, WIDTH, HEIGHT, xs, ys, { color, trimAlphaDeg });
  }, [xs, ys, color, trimAlphaDeg]);

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-8 shrink-0 text-xs">{label}</span>
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        className="bg-background/40 border-border/60 w-full rounded-md border"
        style={{ width: WIDTH, height: HEIGHT }}
      />
    </div>
  );
}
