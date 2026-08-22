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

const DEFAULT_VALUES: SliderValues = { pitchDeg: 0, vInf: 15, cg: { x: 0, y: 0, z: 0 }, bankDeg: 0, yawDeg: 0 };

/** CL/CDi/Cm live in `OutputBar`, pinned under the viewport -- not here, so
 * this panel is purely inputs and can collapse away without hiding the one
 * readout every user actually needs visible at all times. */
export function FlightConditionPanel({ chordEstimateM }: { chordEstimateM: number | null }) {
  const [values, setValues] = useState<SliderValues>(DEFAULT_VALUES);
  const lastSentRef = useRef(0);

  useEngineEvent("meshCleared", () => {
    setValues(DEFAULT_VALUES);
  });

  // Keeps these sliders' displayed values in sync when something OTHER than
  // dragging them changed the flight condition -- e.g. loading a saved
  // project (see `SaveProjectPanel`). Redundant-but-harmless for this
  // panel's own `fire()` calls, which emit the same event right back.
  useEngineEvent("sliderValues", (v) => setValues(v));

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
    engine.sendSlider(next);
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

  // Bank/AoA(pitch)/Yaw are real geometry rotations -- every commit rebuilds
  // the panel model from scratch server-side (see
  // `panel::solve_panel_at_attitude`), unlike the cheap V/CG fields `update`
  // handles above. So dragging only moves the RENDERED model for free
  // (`engine.setAttitudeDeg`, client-side, no network); the expensive real
  // solve only fires once, on release.
  function updateAttitude(patch: Partial<Pick<SliderValues, "bankDeg" | "pitchDeg" | "yawDeg">>, commit: boolean) {
    const next: SliderValues = { ...values, ...patch };
    setValues(next);
    if (commit) {
      engine.sendSlider(next);
    } else {
      engine.setAttitudeDeg(next.bankDeg, next.pitchDeg, next.yawDeg);
    }
  }

  return (
    <Card id="coach-flight-condition" className="w-full gap-3">
      <CardHeader>
        <CardTitle>Flight Condition</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <SliderRow
          label="AoA"
          unit="deg"
          value={values.pitchDeg}
          min={-10}
          max={20}
          step={0.5}
          onValueChange={(v) => updateAttitude({ pitchDeg: v }, false)}
          onValueCommit={(v) => updateAttitude({ pitchDeg: v }, true)}
        />
        <SliderRow
          label="Bank"
          unit="deg"
          value={values.bankDeg}
          min={-90}
          max={90}
          step={1}
          onValueChange={(v) => updateAttitude({ bankDeg: v }, false)}
          onValueCommit={(v) => updateAttitude({ bankDeg: v }, true)}
        />
        <SliderRow
          label="Yaw"
          unit="deg"
          value={values.yawDeg}
          min={-90}
          max={90}
          step={1}
          onValueChange={(v) => updateAttitude({ yawDeg: v }, false)}
          onValueCommit={(v) => updateAttitude({ yawDeg: v }, true)}
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
