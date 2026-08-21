import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Pause, Play, Sparkles } from "lucide-react";

import { engine, useEngineEvent } from "@/lib/engine";
import type { MultiBankSweepFrame } from "@/net/protocol";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

const MIN_FRAMES = 3;
const MAX_FRAMES = 16; // matches the server's own clamp -- see ws::bank_sweep
const MIN_DWELL_S = 0.5;
const MAX_DWELL_S = 8;

/** "Banked flight" animation: every frame is a REAL re-solve -- the mesh is
 * actually rotated to that frame's bank angle, re-panelized (fresh AIC
 * factorization), and re-run through the full LBM flow solver. That's why
 * this is slow (a full "Solve Flow Field" click's worth of work, per frame)
 * and why frame counts are capped so low -- unlike Polar Sweep or Trim,
 * there is no cheap cached-factorization shortcut once the geometry itself
 * changes. Frames stream in one at a time and apply live as they arrive, so
 * progress is visible immediately rather than after the whole batch. */
export function SweepAnimationPanel() {
  const [enabled, setEnabled] = useState(false);

  const [alphaMin, setAlphaMin] = useState("-10");
  const [alphaMax, setAlphaMax] = useState("15");
  const [bankMin, setBankMin] = useState("-25");
  const [bankMax, setBankMax] = useState("25");
  const [nFrames, setNFrames] = useState(8);
  const [dwellS, setDwellS] = useState(2);

  const [error, setError] = useState<string | null>(null);
  const [frames, setFrames] = useState<MultiBankSweepFrame[]>([]);
  const [expectedFrames, setExpectedFrames] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ step: number; maxSteps: number } | null>(null);
  const [computing, setComputing] = useState(false);

  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [playIndex, setPlayIndex] = useState(0);

  const framesRef = useRef<MultiBankSweepFrame[]>([]);

  useEngineEvent("panelResult", () => setEnabled(true));
  useEngineEvent("meshGeometry", () => setEnabled(false));
  useEngineEvent("meshCleared", () => {
    setEnabled(false);
    setFrames([]);
    framesRef.current = [];
    setExpectedFrames(null);
    setComputing(false);
    setPlaying(false);
  });
  useEngineEvent("solveProgress", (p) => setProgress({ step: p.step, maxSteps: p.maxSteps }));
  useEngineEvent("bankSweepFrame", (frame) => {
    setProgress(null);
    setExpectedFrames(frame.nFrames);
    engine.applyBankSweepFrame(frame); // show it immediately, don't wait for the batch
    const next = [...framesRef.current, frame];
    framesRef.current = next;
    setFrames(next);
    if (frame.frameIndex >= frame.nFrames - 1) {
      setComputing(false);
      setPlaying(true);
      setPlayIndex(0);
    }
  });

  function generate() {
    const aMin = Number(alphaMin);
    const aMax = Number(alphaMax);
    const bMin = Number(bankMin);
    const bMax = Number(bankMax);
    if (!Number.isFinite(aMin) || !Number.isFinite(aMax) || aMax <= aMin) {
      setError("Alpha max must be greater than alpha min.");
      return;
    }
    if (!Number.isFinite(bMin) || !Number.isFinite(bMax) || bMax <= bMin) {
      setError("Bank max must be greater than bank min.");
      return;
    }
    setError(null);
    setFrames([]);
    framesRef.current = [];
    setExpectedFrames(null);
    setProgress(null);
    setPlaying(false);
    setComputing(true);
    engine.requestBankSweep(aMin, aMax, bMin, bMax, nFrames);
  }

  // Playback: step through the already-arrived REAL frames on a fixed
  // dwell timer -- no interpolation, each frame is its own discrete solved
  // state, not a sample of a continuous function.
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const id = setInterval(() => {
      setPlayIndex((i) => {
        const next = i + 1;
        if (next >= frames.length) {
          if (!loop) {
            setPlaying(false);
            return i;
          }
          engine.applyBankSweepFrame(frames[0]);
          return 0;
        }
        engine.applyBankSweepFrame(frames[next]);
        return next;
      });
    }, dwellS * 1000);
    return () => clearInterval(id);
  }, [playing, frames, loop, dwellS]);

  const computedCount = frames.length;
  const totalExpected = expectedFrames ?? nFrames;
  const current = frames[playing ? playIndex : computedCount - 1];

  return (
    <Card className="w-full gap-3">
      <CardHeader>
        <CardTitle>Sweep Animation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-normal">Angle of attack range</Label>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              value={alphaMin}
              onChange={(e) => setAlphaMin(e.target.value)}
              step={0.5}
              disabled={computing}
              className="h-8 w-16 px-2 text-xs"
              aria-label="alpha min (deg)"
            />
            <span className="text-muted-foreground text-xs">to</span>
            <Input
              type="number"
              value={alphaMax}
              onChange={(e) => setAlphaMax(e.target.value)}
              step={0.5}
              disabled={computing}
              className="h-8 w-16 px-2 text-xs"
              aria-label="alpha max (deg)"
            />
            <span className="text-muted-foreground text-xs">deg</span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-normal" title="A REAL rotation of the mesh -- each frame is re-panelized and re-solved (panel method + full LBM) at this bank angle.">
            Bank angle range
          </Label>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              value={bankMin}
              onChange={(e) => setBankMin(e.target.value)}
              step={1}
              disabled={computing}
              className="h-8 w-16 px-2 text-xs"
              aria-label="bank min (deg)"
            />
            <span className="text-muted-foreground text-xs">to</span>
            <Input
              type="number"
              value={bankMax}
              onChange={(e) => setBankMax(e.target.value)}
              step={1}
              disabled={computing}
              className="h-8 w-16 px-2 text-xs"
              aria-label="bank max (deg)"
            />
            <span className="text-muted-foreground text-xs">deg</span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-normal">Frames (full re-solve each)</Label>
            <span className="font-data text-muted-foreground text-xs">{nFrames}</span>
          </div>
          <Slider
            value={[nFrames]}
            min={MIN_FRAMES}
            max={MAX_FRAMES}
            step={1}
            disabled={computing}
            onValueChange={([v]) => setNFrames(v)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-normal">Playback speed</Label>
            <span className="font-data text-muted-foreground text-xs">{dwellS.toFixed(1)}s / frame</span>
          </div>
          <Slider value={[dwellS]} min={MIN_DWELL_S} max={MAX_DWELL_S} step={0.5} onValueChange={([v]) => setDwellS(v)} />
        </div>

        {error && <p className="text-destructive text-xs">{error}</p>}

        <Button size="sm" disabled={!enabled || computing} onClick={generate} className="w-full">
          {computing ? (
            <>
              <LoaderCircle className="animate-spin" /> Computing…
            </>
          ) : (
            <>
              <Sparkles /> Generate Animation
            </>
          )}
        </Button>

        {computing && (
          <div className="flex flex-col gap-1">
            <Progress value={(computedCount / totalExpected) * 100} />
            <span className="text-muted-foreground text-center text-xs">
              Frame {Math.min(computedCount + 1, totalExpected)} of {totalExpected}
              {progress && ` — LBM step ${progress.step}/${progress.maxSteps}`}
            </span>
          </div>
        )}

        {computedCount > 0 && !computing && (
          <>
            <Separator />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => setPlaying((p) => !p)} className="flex-1">
                {playing ? (
                  <>
                    <Pause /> Pause
                  </>
                ) : (
                  <>
                    <Play /> Play
                  </>
                )}
              </Button>
              <Label className="flex items-center gap-1.5 text-xs font-normal">
                Loop
                <Switch checked={loop} onCheckedChange={setLoop} />
              </Label>
            </div>
            {current && (
              <div className="font-data text-muted-foreground flex justify-center gap-3 text-xs">
                <span>
                  frame {(playing ? playIndex : computedCount - 1) + 1}/{computedCount}
                </span>
                <span>α {current.alphaDeg.toFixed(1)}°</span>
                <span>bank {current.bankDeg.toFixed(1)}°</span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
