import { useEffect, useMemo, useRef, useState } from "react";

import { engine, useEngineEvent, type SliderValues } from "@/lib/engine";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";

// Slider updates fire continuously while dragging; throttling keeps that
// from flooding the WS with more SliderUpdate frames than the panel-method
// solve can usefully keep up with. onValueCommit (pointer release) always
// sends regardless of the throttle window, so the final value is never lost.
const THROTTLE_MS = 33;

// bankDeg here is a placeholder only -- this panel has no bank UI of its own
// (that lives in the viewport's RotateControl) and `fire` below always
// overwrites it with the engine's live value before sending, so changing
// alpha/V/CG here can never silently reset whatever bank the user last set.
const DEFAULT_VALUES: SliderValues = { alphaDeg: 0, vInf: 15, cg: { x: 0, y: 0, z: 0 }, bankDeg: 0 };

/** CL/CDi/Cm live in `OutputBar`, pinned under the viewport -- not here, so
 * this panel is purely inputs and can collapse away without hiding the one
 * readout every user actually needs visible at all times. */
export function FlightConditionPanel({ chordEstimateM }: { chordEstimateM: number | null }) {
  const [values, setValues] = useState<SliderValues>(DEFAULT_VALUES);
  const lastSentRef = useRef(0);

  useEngineEvent("meshCleared", () => {
    setValues(DEFAULT_VALUES);
  });

  // Re-centers the CG-x slider's default/range around a newly-imported
  // mesh's chord estimate -- same quarter-chord-default heuristic the
  // server itself uses for the very first PanelResult it sends on import.
  useEffect(() => {
    if (chordEstimateM == null) return;
    const c = Math.max(chordEstimateM, 0.01);
    setValues((v) => ({ ...v, cg: { ...v.cg, x: c * 0.25 } }));
  }, [chordEstimateM]);

  const cgXRange = useMemo(() => {
    const c = Math.max(chordEstimateM ?? 0.2, 0.01);
    return { min: -0.1 * c, max: 1.1 * c, step: c / 40 };
  }, [chordEstimateM]);

  function fire(next: SliderValues, force: boolean) {
    const now = performance.now();
    if (!force && now - lastSentRef.current < THROTTLE_MS) return;
    lastSentRef.current = now;
    // Always the engine's live bank angle, never this panel's own (always-0)
    // placeholder -- see DEFAULT_VALUES's comment.
    engine.sendSlider({ ...next, bankDeg: engine.getLastSliderValues().bankDeg });
  }

  function update(patch: Partial<SliderValues> | { cg: Partial<SliderValues["cg"]> }, commit: boolean) {
    const next: SliderValues = {
      ...values,
      ...patch,
      cg: { ...values.cg, ...(patch as { cg?: Partial<SliderValues["cg"]> }).cg },
    };
    setValues(next);
    fire(next, commit);
  }

  return (
    <Card className="w-full gap-3">
      <CardHeader>
        <CardTitle>Flight Condition</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <SliderRow
          label="AoA"
          unit="deg"
          value={values.alphaDeg}
          min={-10}
          max={20}
          step={0.5}
          onValueChange={(v) => update({ alphaDeg: v }, false)}
          onValueCommit={(v) => update({ alphaDeg: v }, true)}
        />
        <SliderRow
          label="Airspeed"
          unit="m/s"
          value={values.vInf}
          min={5}
          max={30}
          step={0.5}
          onValueChange={(v) => update({ vInf: v }, false)}
          onValueCommit={(v) => update({ vInf: v }, true)}
        />
        <SliderRow
          label="CG x"
          unit="m"
          value={values.cg.x}
          min={cgXRange.min}
          max={cgXRange.max}
          step={cgXRange.step}
          decimals={4}
          onValueChange={(v) => update({ cg: { x: v } }, false)}
          onValueCommit={(v) => update({ cg: { x: v } }, true)}
        />
        <SliderRow
          label="CG y"
          unit="m"
          value={values.cg.y}
          min={-0.05}
          max={0.05}
          step={0.002}
          decimals={4}
          onValueChange={(v) => update({ cg: { y: v } }, false)}
          onValueCommit={(v) => update({ cg: { y: v } }, true)}
        />
        <SliderRow
          label="CG z"
          unit="m"
          value={values.cg.z}
          min={-0.2}
          max={0.2}
          step={0.01}
          decimals={4}
          onValueChange={(v) => update({ cg: { z: v } }, false)}
          onValueCommit={(v) => update({ cg: { z: v } }, true)}
        />
      </CardContent>
    </Card>
  );
}

function SliderRow({
  label,
  unit,
  value,
  min,
  max,
  step,
  decimals = 1,
  onValueChange,
  onValueCommit,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  onValueChange: (v: number) => void;
  onValueCommit: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-normal">
          {label} <span className="text-muted-foreground">({unit})</span>
        </Label>
        <span className="font-data text-muted-foreground text-xs">{value.toFixed(decimals)}</span>
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
