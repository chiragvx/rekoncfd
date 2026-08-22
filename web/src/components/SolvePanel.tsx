import { useState } from "react";

import { engine, useEngineEvent } from "@/lib/engine";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export function SolvePanel() {
  const [enabled, setEnabled] = useState(false);
  const [solving, setSolving] = useState(false);
  const [progress, setProgress] = useState<{ step: number; maxSteps: number; maxVelocity: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEngineEvent("meshGeometry", () => setEnabled(true));
  useEngineEvent("meshCleared", () => {
    setEnabled(false);
    setSolving(false);
    setProgress(null);
    setStatus(null);
  });
  useEngineEvent("solveStarted", () => {
    setSolving(true);
    setProgress(null);
    setStatus(null);
  });
  useEngineEvent("solveProgress", (p) => setProgress(p));
  useEngineEvent("solveDone", (elapsedMs) => {
    setSolving(false);
    setStatus(`converged in ${(elapsedMs / 1000).toFixed(1)}s`);
  });
  useEngineEvent("solveError", (message) => {
    setSolving(false);
    setStatus(message);
  });

  const pct = progress && progress.maxSteps > 0 ? Math.min(100, (progress.step / progress.maxSteps) * 100) : 0;

  return (
    <Card id="coach-solve" className="w-full gap-3">
      <CardHeader>
        <CardTitle>Flow Solve</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Button disabled={!enabled || solving} onClick={() => engine.requestSolve()} className="w-full">
          {solving ? "Solving…" : "Solve Flow Field"}
        </Button>
        {solving && (
          <>
            <Progress value={pct} />
            {progress && (
              <span className="font-data text-muted-foreground text-xs">
                step {progress.step}/{progress.maxSteps} &nbsp;|v|max={progress.maxVelocity.toFixed(4)}
              </span>
            )}
          </>
        )}
        {!solving && status && <span className="text-muted-foreground text-xs">{status}</span>}
      </CardContent>
    </Card>
  );
}
