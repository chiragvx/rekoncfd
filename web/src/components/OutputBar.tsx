import { useState } from "react";

import { useEngineEvent, type DecodedPanelResult, type DecodedTrimResult } from "@/lib/engine";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-16 flex-col items-center gap-0.5">
      <span className="text-muted-foreground text-[10px] tracking-wider uppercase">{label}</span>
      <span className="font-data text-base leading-none">{value}</span>
    </div>
  );
}

/** The live physics readout, pinned to a fixed bar under the viewport instead
 * of living inside a scrolling side panel -- it's the single most-watched
 * number in the whole tool, and burying it below other panel content (STL
 * warnings, orientation controls, ...) meant it could scroll out of view
 * entirely. Self-sufficient (subscribes to engine events directly) so it
 * doesn't need any prop-drilled connection to Flight Condition or Stability. */
export function OutputBar() {
  const [panel, setPanel] = useState<DecodedPanelResult | null>(null);
  const [trim, setTrim] = useState<DecodedTrimResult | null>(null);

  useEngineEvent("panelResult", setPanel);
  useEngineEvent("meshCleared", () => {
    setPanel(null);
    setTrim(null);
  });
  useEngineEvent("trimResult", setTrim);

  return (
    <div className="surface-elevated bg-card/95 flex shrink-0 items-center justify-center gap-3 rounded-2xl border px-6 py-3 backdrop-blur-sm">
      <Stat label="CL" value={panel ? panel.cl.toFixed(3) : "—"} />
      <Separator orientation="vertical" className="h-8" />
      <Stat label="CDi" value={panel ? panel.cdInduced.toFixed(4) : "—"} />
      <Separator orientation="vertical" className="h-8" />
      <Stat label="Cm" value={panel ? panel.cm.toFixed(3) : "—"} />
      {trim?.ok && (
        <>
          <Separator orientation="vertical" className="h-8" />
          <Stat label="Static Margin" value={`${(trim.staticMargin * 100).toFixed(1)}%`} />
          <Badge variant={trim.staticMargin > 0 ? "success" : "destructive"} className="ml-1">
            {trim.staticMargin > 0 ? "stable" : "unstable"}
          </Badge>
        </>
      )}
      {!panel && (
        <span className="text-muted-foreground ml-2 text-xs">Import or generate a wing to see live values</span>
      )}
    </div>
  );
}
