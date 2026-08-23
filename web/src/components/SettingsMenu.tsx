import { useEffect, useRef, useState } from "react";
import { RotateCcw, Settings } from "lucide-react";

import { DEFAULT_STREAMLINE_SETTINGS, type StreamlineSettings } from "@/viz/streamlines";
import { DEFAULT_SOLVE_QUALITY, engine, type SolveQuality } from "@/lib/engine";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";

/** CFD visualization tuning -- how streamlines are traced/rendered, as
 * opposed to `VisualizationPanel`'s on/off layer toggles (whether they're
 * shown at all). Docked in the top nav strip next to `ProjectMenu`, since
 * these are session-wide rendering preferences rather than per-panel
 * controls. `seedCount`/`minSeparationFraction`/`turbulenceGamma` only apply
 * on commit (pointer release) -- each one costs a full streamline re-trace
 * (see `Streamlines.setStreamlineSettings`), so applying them on every drag
 * tick would make dragging visibly janky. `lineWidthPx` is a material
 * uniform, cheap enough to apply live on every drag tick instead. */
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<StreamlineSettings>(() => engine.getVizState().streamlineSettings);
  const [quality, setQuality] = useState<SolveQuality>(() => engine.getVizState().solveQuality);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function apply(next: StreamlineSettings) {
    const vizState = engine.getVizState();
    engine.applyVizState({ ...vizState, streamlineSettings: next });
  }

  /** Live: applied to the engine on every drag tick (cheap, no re-trace). */
  function updateLive(patch: Partial<StreamlineSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    apply(next);
  }

  /** Deferred: only reaches the engine when `commit` is true (pointer
   * release) -- dragging still updates the displayed number for free. */
  function updateDeferred(patch: Partial<StreamlineSettings>, commit: boolean) {
    const next = { ...settings, ...patch };
    setSettings(next);
    if (commit) apply(next);
  }

  function reset() {
    setSettings({ ...DEFAULT_STREAMLINE_SETTINGS });
    apply({ ...DEFAULT_STREAMLINE_SETTINGS });
  }

  /** No re-trace/re-solve happens just from changing this -- it's only read
   * the next time "Solve Flow Field" is clicked -- so every drag tick can
   * push straight to the engine with no live/deferred split needed. */
  function updateQuality(patch: Partial<SolveQuality>) {
    const next = { ...quality, ...patch };
    setQuality(next);
    const vizState = engine.getVizState();
    engine.applyVizState({ ...vizState, solveQuality: next });
  }

  function resetQuality() {
    setQuality({ ...DEFAULT_SOLVE_QUALITY });
    const vizState = engine.getVizState();
    engine.applyVizState({ ...vizState, solveQuality: { ...DEFAULT_SOLVE_QUALITY } });
  }

  return (
    <div ref={containerRef} className="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} className="gap-1.5">
        <Settings className="size-4" /> Settings
      </Button>

      {open && (
        <div className="border-border bg-popover surface-elevated absolute top-full right-0 z-30 mt-2 w-72 rounded-lg border p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Streamline rendering</span>
            <button
              type="button"
              title="Reset to defaults"
              onClick={reset}
              className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors"
            >
              <RotateCcw className="size-3.5" />
            </button>
          </div>

          <div className="flex flex-col gap-3">
            <SettingRow
              label="Seed count"
              value={settings.seedCount}
              unit=""
              decimals={0}
              min={40}
              max={800}
              step={10}
              onValueChange={(v) => updateDeferred({ seedCount: v }, false)}
              onValueCommit={(v) => updateDeferred({ seedCount: v }, true)}
            />
            <SettingRow
              label="Line width"
              value={settings.lineWidthPx}
              unit="px"
              decimals={1}
              min={0.5}
              max={4}
              step={0.1}
              onValueChange={(v) => updateLive({ lineWidthPx: v })}
              onValueCommit={(v) => updateLive({ lineWidthPx: v })}
            />
            <SettingRow
              label="Line spacing"
              title="Minimum gap kept between streamlines -- higher values thin out bunching near the body at the cost of overall coverage."
              value={settings.minSeparationFraction}
              unit=""
              decimals={3}
              min={0}
              max={0.05}
              step={0.002}
              onValueChange={(v) => updateDeferred({ minSeparationFraction: v }, false)}
              onValueCommit={(v) => updateDeferred({ minSeparationFraction: v }, true)}
            />
            <SettingRow
              label="Turbulence sensitivity"
              title="Lower values make the color scale redden at weaker turbulence; higher values require stronger turbulence before it reads as red."
              value={settings.turbulenceGamma}
              unit=""
              decimals={2}
              min={0.2}
              max={1.2}
              step={0.05}
              onValueChange={(v) => updateDeferred({ turbulenceGamma: v }, false)}
              onValueCommit={(v) => updateDeferred({ turbulenceGamma: v }, true)}
            />
          </div>

          <Separator className="my-3" />

          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Flow solve quality</span>
            <button
              type="button"
              title="Reset to defaults"
              onClick={resetQuality}
              className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors"
            >
              <RotateCcw className="size-3.5" />
            </button>
          </div>
          <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
            Applies on your next "Solve Flow Field" -- higher values give a finer flow field at the cost of a
            longer solve.
          </p>
          <div className="flex flex-col gap-3">
            <SettingRow
              label="Grid resolution"
              title="Scales the LBM solve's voxel grid (and the flow field sampled back from it) in all three axes -- cell count scales with the cube of this value."
              value={quality.resolutionMultiplier}
              unit="x"
              decimals={1}
              min={0.5}
              max={2}
              step={0.1}
              onValueChange={(v) => updateQuality({ resolutionMultiplier: v })}
              onValueCommit={(v) => updateQuality({ resolutionMultiplier: v })}
            />
            <SettingRow
              label="Max steps"
              title="The solver's step cap -- more steps let the flow field settle further before the solve is called done."
              value={quality.maxSteps}
              unit=""
              decimals={0}
              min={100}
              max={800}
              step={50}
              onValueChange={(v) => updateQuality({ maxSteps: v })}
              onValueCommit={(v) => updateQuality({ maxSteps: v })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function SettingRow({
  label,
  title,
  value,
  unit,
  decimals,
  min,
  max,
  step,
  onValueChange,
  onValueCommit,
}: {
  label: string;
  title?: string;
  value: number;
  unit: string;
  decimals: number;
  min: number;
  max: number;
  step: number;
  onValueChange: (v: number) => void;
  onValueCommit: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-normal" title={title}>
          {label}
        </Label>
        <span className="font-data text-muted-foreground text-xs">
          {value.toFixed(decimals)}
          {unit}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onValueChange(v)}
        onValueCommit={([v]) => onValueCommit(v)}
      />
    </div>
  );
}
