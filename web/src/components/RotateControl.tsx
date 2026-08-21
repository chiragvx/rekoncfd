import { useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

import { engine, useEngineEvent } from "@/lib/engine";
import { cn } from "@/lib/utils";

const MIN_BANK_DEG = -90;
const MAX_BANK_DEG = 90;
const TRACK_WIDTH_PX = 160;

/** Maps a pointer's X position (relative to the track's left edge) to a bank
 * angle in [MIN_BANK_DEG, MAX_BANK_DEG], clamped. */
function angleFromTrackX(clientX: number, trackRect: DOMRect): number {
  const t = (clientX - trackRect.left) / trackRect.width;
  const clamped = Math.min(1, Math.max(0, t));
  return MIN_BANK_DEG + clamped * (MAX_BANK_DEG - MIN_BANK_DEG);
}

/** Drag-to-set-bank-angle control overlaid directly on the 3D viewport --
 * distinct from (and simpler than) camera orbiting: dragging here rotates
 * the MODEL itself (a real geometric bank angle, re-solved on release), not
 * the view. Live-drags update the rendered model instantly at zero cost
 * (`engine.setBankDeg`, client-side only); releasing commits the angle via a
 * real `SliderUpdate`, which triggers a fresh panel-model rebuild server-side
 * -- see `panel::solve_panel_at_bank`. This is deliberately a dedicated
 * control rather than overloading ambiguous canvas-drag gestures, which are
 * already claimed by the trackball camera controls. */
export function RotateControl() {
  const trackRef = useRef<HTMLDivElement>(null);
  const [bankDeg, setBankDegLocal] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Also fires for a fresh mesh (which resets bank to 0) and for an applied
  // bank-sweep animation frame, so this control's displayed angle always
  // matches reality regardless of which of those last changed it -- except
  // while the user is actively dragging THIS control, where the drag itself
  // is authoritative.
  useEngineEvent("bankDeg", (deg) => {
    if (!dragging) setBankDegLocal(deg);
  });

  function commit(deg: number) {
    const current = engine.getLastSliderValues();
    engine.sendSlider({ ...current, bankDeg: deg });
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const track = trackRef.current;
    if (!track) return;
    track.setPointerCapture(e.pointerId);
    setDragging(true);
    const deg = angleFromTrackX(e.clientX, track.getBoundingClientRect());
    setBankDegLocal(deg);
    engine.setBankDeg(deg);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    const track = trackRef.current;
    if (!track) return;
    const deg = angleFromTrackX(e.clientX, track.getBoundingClientRect());
    setBankDegLocal(deg);
    engine.setBankDeg(deg);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    const track = trackRef.current;
    track?.releasePointerCapture(e.pointerId);
    setDragging(false);
    // Recompute from the event's own coordinates rather than reading the
    // `bankDeg` state variable: if this handler's closure predates the
    // re-render from the last `onPointerMove` (a fast release can easily
    // outrun React here), that state would be one step stale and commit the
    // wrong angle -- the pointer's actual final position is always correct.
    const deg = track ? angleFromTrackX(e.clientX, track.getBoundingClientRect()) : bankDeg;
    setBankDegLocal(deg);
    engine.setBankDeg(deg);
    commit(deg);
  }

  function reset() {
    setBankDegLocal(0);
    engine.setBankDeg(0);
    commit(0);
  }

  const handleT = (bankDeg - MIN_BANK_DEG) / (MAX_BANK_DEG - MIN_BANK_DEG);

  return (
    <div className="border-border/60 bg-card/90 absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2.5 rounded-lg border p-1.5 pl-3 backdrop-blur-sm">
      <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">Bank</span>
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="relative h-6 shrink-0 cursor-ew-resize touch-none rounded-full bg-black/30"
        style={{ width: TRACK_WIDTH_PX }}
        title="Drag to set bank angle"
      >
        {/* Center (wings-level) tick */}
        <span className="bg-border absolute top-1/2 left-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2" />
        <div
          className={cn(
            "bg-primary absolute top-1/2 size-4 -translate-y-1/2 rounded-full shadow transition-[left]",
            dragging ? "duration-0" : "duration-150",
          )}
          style={{ left: `calc(${handleT * 100}% - ${handleT * 16}px)` }}
        />
      </div>
      <span className="font-data text-muted-foreground w-11 shrink-0 text-xs tabular-nums">{bankDeg.toFixed(0)}°</span>
      <button
        type="button"
        onClick={reset}
        title="Reset to wings-level"
        className="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded-md p-1.5 transition-colors"
      >
        <RotateCcw className="size-3.5" />
      </button>
    </div>
  );
}
