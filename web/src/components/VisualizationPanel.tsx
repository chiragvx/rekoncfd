import { useState } from "react";

import { DEFAULT_VIZ_STATE, engine, SliceAxis, type VizState } from "@/lib/engine";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

const LAYERS: { key: "pressure" | "streamlines" | "vorticity" | "contour"; label: string }[] = [
  { key: "pressure", label: "Surface pressure" },
  { key: "streamlines", label: "Streamlines (turbulence)" },
  { key: "vorticity", label: "Vorticity hotspots" },
  { key: "contour", label: "Speed contour plane" },
];

const AXIS_LABELS: [SliceAxis, string][] = [
  [SliceAxis.X, "X (cross-flow rake)"],
  [SliceAxis.Y, "Y (horizontal)"],
  [SliceAxis.Z, "Z (spanwise)"],
];

export function VisualizationPanel() {
  const [state, setState] = useState<VizState>(DEFAULT_VIZ_STATE);

  function apply(next: VizState) {
    setState(next);
    engine.applyVizState(next);
  }

  const planeControlsRelevant = state.seedPlane || state.contour;

  return (
    <Card className="w-full gap-3">
      <CardHeader>
        <CardTitle>Visualization</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {LAYERS.map((layer) => (
          <div key={layer.key} className="flex items-center justify-between">
            <Label htmlFor={`layer-${layer.key}`} className="text-xs font-normal">
              {layer.label}
            </Label>
            <Switch
              id={`layer-${layer.key}`}
              checked={state[layer.key]}
              onCheckedChange={(checked) => apply({ ...state, [layer.key]: checked })}
            />
          </div>
        ))}

        <Separator />

        <div className="flex items-center justify-between">
          <Label htmlFor="seed-plane" className="text-xs font-normal" title="Release streamlines from a grid of points on this plane; they then follow the flow freely in 3D.">
            Seed streamlines from plane
          </Label>
          <Switch
            id="seed-plane"
            checked={state.seedPlane}
            onCheckedChange={(checked) => apply({ ...state, seedPlane: checked })}
          />
        </div>

        <div className={planeControlsRelevant ? "flex flex-col gap-2" : "flex flex-col gap-2 opacity-45"}>
          <div className="flex items-center justify-between gap-2">
            <Label className="text-muted-foreground text-xs font-normal">Plane</Label>
            <Select
              value={String(state.planeAxis)}
              onValueChange={(v) => apply({ ...state, planeAxis: Number(v) as SliceAxis })}
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AXIS_LABELS.map(([v, l]) => (
                  <SelectItem key={v} value={String(v)}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-muted-foreground text-xs font-normal">Position</Label>
            <Slider
              value={[state.planePosition * 100]}
              min={0}
              max={100}
              step={1}
              onValueChange={([v]) => apply({ ...state, planePosition: v / 100 })}
            />
            <span className="text-muted-foreground w-9 shrink-0 text-right text-xs">
              {Math.round(state.planePosition * 100)}%
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
