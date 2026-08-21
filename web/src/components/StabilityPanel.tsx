import { useState } from "react";

import { engine, useEngineEvent, type DecodedTrimResult, type PolarPoint } from "@/lib/engine";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { PolarChart } from "@/components/PolarChart";

export function StabilityPanel() {
  // A PanelResult only ever arrives when the server actually has a panel
  // model for the current mesh (see ws/connection.rs's send_panel_result),
  // so its arrival -- not just a mesh existing -- is the real "trim/polar
  // requests are safe" signal (large meshes skip the live solve entirely;
  // see MAX_PANEL_METHOD_PANELS).
  const [enabled, setEnabled] = useState(false);
  const [trimBusy, setTrimBusy] = useState(false);
  const [trim, setTrim] = useState<DecodedTrimResult | null>(null);
  const [polarBusy, setPolarBusy] = useState(false);
  const [polar, setPolar] = useState<PolarPoint[] | null>(null);
  const [alphaMin, setAlphaMin] = useState("-10");
  const [alphaMax, setAlphaMax] = useState("15");
  const [nPoints, setNPoints] = useState("16");
  const [rangeError, setRangeError] = useState<string | null>(null);

  useEngineEvent("panelResult", () => setEnabled(true));
  useEngineEvent("meshGeometry", () => setEnabled(false));
  useEngineEvent("meshCleared", () => {
    setEnabled(false);
    setTrim(null);
    setPolar(null);
  });
  useEngineEvent("trimResult", (result) => {
    setTrimBusy(false);
    setTrim(result);
  });
  useEngineEvent("polarCurve", (points) => {
    setPolarBusy(false);
    setPolar(points);
  });

  function findTrim() {
    setTrimBusy(true);
    engine.requestTrim();
  }

  function runSweep() {
    const min = Number(alphaMin);
    const max = Number(alphaMax);
    const n = Math.round(Number(nPoints));
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      setRangeError("Alpha max must be greater than alpha min.");
      return;
    }
    setRangeError(null);
    setPolarBusy(true);
    engine.requestPolar(min, max, n);
  }

  const trimAlphaDeg = trim?.ok ? trim.alphaDeg : undefined;

  return (
    <Card className="w-full gap-3">
      <CardHeader>
        <CardTitle>Trim &amp; Stability</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button size="sm" disabled={!enabled || trimBusy} onClick={findTrim} className="w-full">
          {trimBusy ? "Searching…" : "Find Trim"}
        </Button>

        {trim ? (
          trim.ok ? (
            <div className="font-data flex flex-col gap-1 text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  trim &alpha; <strong className="text-foreground">{trim.alphaDeg.toFixed(2)}°</strong>
                </span>
                <span>
                  CL <strong className="text-foreground">{trim.cl.toFixed(3)}</strong>
                </span>
                <span>
                  Cm <strong className="text-foreground">{trim.cm.toExponential(2)}</strong>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span>static margin {(trim.staticMargin * 100).toFixed(1)}% MAC</span>
                <Badge variant={trim.staticMargin > 0 ? "success" : "destructive"} className="text-[10px]">
                  {trim.staticMargin > 0 ? "stable" : "unstable"}
                </Badge>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              No trim point in [{trim.alphaLoDeg.toFixed(0)}°, {trim.alphaHiDeg.toFixed(0)}°] — Cm stays{" "}
              {trim.cmLo >= 0 ? "positive" : "negative"} across the whole bracket.
            </p>
          )
        ) : (
          <p className="text-muted-foreground text-xs">No trim computed yet.</p>
        )}

        <Separator />

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium">Polar Sweep</span>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              value={alphaMin}
              onChange={(e) => setAlphaMin(e.target.value)}
              step={0.5}
              className="h-8 w-16 px-2 text-xs"
              aria-label="alpha min (deg)"
            />
            <span className="text-muted-foreground text-xs">to</span>
            <Input
              type="number"
              value={alphaMax}
              onChange={(e) => setAlphaMax(e.target.value)}
              step={0.5}
              className="h-8 w-16 px-2 text-xs"
              aria-label="alpha max (deg)"
            />
            <span className="text-muted-foreground text-xs">deg,</span>
            <Input
              type="number"
              value={nPoints}
              onChange={(e) => setNPoints(e.target.value)}
              min={2}
              max={200}
              step={1}
              className="h-8 w-14 px-2 text-xs"
              aria-label="number of points"
            />
            <span className="text-muted-foreground text-xs">pts</span>
          </div>
          {rangeError && <p className="text-destructive text-xs">{rangeError}</p>}
          <Button size="sm" variant="secondary" disabled={!enabled || polarBusy} onClick={runSweep} className="w-full">
            {polarBusy ? "Sweeping…" : "Run Sweep"}
          </Button>
          {polar && (
            <span className="text-muted-foreground text-xs">
              {polar.length} points, {polar[0]?.alphaDeg.toFixed(1)}° to {polar[polar.length - 1]?.alphaDeg.toFixed(1)}°
            </span>
          )}
        </div>

        {polar && polar.length > 0 && (
          <div className="flex flex-col gap-2">
            <PolarChart label="CL" xs={polar.map((p) => p.alphaDeg)} ys={polar.map((p) => p.cl)} color="#6fb3ff" trimAlphaDeg={trimAlphaDeg} />
            <PolarChart label="CDi" xs={polar.map((p) => p.alphaDeg)} ys={polar.map((p) => p.cdInduced)} color="#7be0a8" trimAlphaDeg={trimAlphaDeg} />
            <PolarChart label="Cm" xs={polar.map((p) => p.alphaDeg)} ys={polar.map((p) => p.cm)} color="#e0a8ff" trimAlphaDeg={trimAlphaDeg} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
