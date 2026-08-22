import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";

const SEEN_KEY = "rekon:coachmarksSeen";

interface Step {
  targetId: string;
  title: string;
  body: string;
  /** Which side of the target the callout card should sit on -- both
   * anchors live in the right sidebar (fine to always drop below), while
   * the solve button lives in the left sidebar and reads better with the
   * callout above it, closer to the button it's actually about. */
  placement: "below" | "above";
}

const STEPS: Step[] = [
  {
    targetId: "coach-import",
    title: "1. Bring in a wing",
    body: "Drop an STL here, or open a sample from Explore Models — either way you'll have a mesh to fly in seconds.",
    placement: "below",
  },
  {
    targetId: "coach-flight-condition",
    title: "2. Set the flight condition",
    body: "Drag angle of attack, airspeed, or CG. The panel-method solver re-solves live, so CL/CDi/Cm update as you move each slider.",
    placement: "below",
  },
  {
    targetId: "coach-solve",
    title: "3. Solve the flow field",
    body: "This runs a full lattice-Boltzmann solve for real pressure, streamlines, and vorticity in 3D — the panel-method numbers above are instant, but this one takes a few seconds.",
    placement: "above",
  },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** A first-time-only, 3-step walkthrough pointing at the three panels a new
 * user actually needs to notice (import, flight condition, solve) -- all
 * three are static parts of the Tool page's own layout, present whether or
 * not a mesh is loaded yet, so this runs on mount rather than waiting for
 * any app state. Gated by a localStorage flag so it never shows again once
 * dismissed, whether by finishing it or skipping it. */
export function CoachMarks() {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (dismissed) return;

    function measure() {
      const el = document.getElementById(STEPS[step].targetId);
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    }

    // One tick after mount/step-change so the Tool page's own layout (fonts,
    // collapsible sections) has settled before the first measurement.
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step, dismissed]);

  function finish() {
    setDismissed(true);
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* private browsing or storage disabled -- worst case this just reappears next visit */
    }
  }

  if (dismissed || !rect) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  // Estimated callout height for clamping purposes only (its real height
  // depends on content/font-loading and isn't known until after it renders) --
  // generous enough that the clamp below keeps it fully on-screen even if
  // the estimate is a bit off, on either a "below" or "above" placement.
  const ESTIMATED_CALLOUT_HEIGHT = 200;
  const desiredTop =
    current.placement === "below" ? rect.top + rect.height + 12 : rect.top - ESTIMATED_CALLOUT_HEIGHT - 12;
  const calloutTop = Math.min(Math.max(desiredTop, 16), window.innerHeight - ESTIMATED_CALLOUT_HEIGHT - 16);

  return (
    <div className="fixed inset-0 z-50">
      {/* Spotlight: a box exactly matching the target, with a giant box-shadow
       * darkening everything else -- avoids needing an SVG mask for a simple
       * rectangular cutout. Not interactive itself; a separate full-screen
       * layer below it captures clicks so the user has to use Next/Skip
       * rather than poke at the rest of the app mid-walkthrough. */}
      <div className="absolute inset-0" onClick={finish} />
      <div
        className="border-primary/70 pointer-events-none absolute rounded-lg border-2 transition-all duration-300"
        style={{
          top: rect.top - 6,
          left: rect.left - 6,
          width: rect.width + 12,
          height: rect.height + 12,
          boxShadow: "0 0 0 9999px rgba(5, 7, 12, 0.75)",
        }}
      />

      <div
        className="border-border bg-card surface-elevated absolute w-80 rounded-xl border p-4"
        style={{
          left: Math.min(Math.max(rect.left, 16), window.innerWidth - 336),
          top: calloutTop,
        }}
      >
        <button
          type="button"
          onClick={finish}
          aria-label="Skip walkthrough"
          className="text-muted-foreground hover:text-foreground absolute top-3 right-3 rounded-md p-1 transition-colors"
        >
          <X className="size-3.5" />
        </button>
        <span className="text-primary font-data text-[10px] tracking-[0.15em] uppercase">
          Step {step + 1} of {STEPS.length}
        </span>
        <h3 className="mt-1.5 text-sm font-medium tracking-tight">{current.title}</h3>
        <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{current.body}</p>
        <div className="mt-3 flex items-center justify-between">
          <button
            type="button"
            onClick={finish}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            Skip
          </button>
          <Button size="sm" onClick={() => (isLast ? finish() : setStep((s) => s + 1))}>
            {isLast ? "Got it" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
