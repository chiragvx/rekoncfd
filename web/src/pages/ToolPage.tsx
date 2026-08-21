import { useState, type ReactNode } from "react";

import type { ImportSummary } from "@/lib/engine";
import { Viewport } from "@/components/Viewport";
import { ToolNav } from "@/components/ToolNav";
import { UpdateBanner } from "@/components/UpdateBanner";
import { ImportPanel } from "@/components/ImportPanel";
import { FlightConditionPanel } from "@/components/FlightConditionPanel";
import { StabilityPanel } from "@/components/StabilityPanel";
import { VisualizationPanel } from "@/components/VisualizationPanel";
import { SolvePanel } from "@/components/SolvePanel";

/** Groups a cluster of related panels under a small uppercase label, so the
 * two side columns read as named sections (Model / Aerodynamics / Flow
 * Field) instead of an undifferentiated stack of cards. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <span className="bg-primary/70 h-px w-3" />
        <span className="font-data text-muted-foreground text-[11px] font-medium tracking-[0.15em] uppercase">
          {label}
        </span>
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

export function ToolPage() {
  const [chordEstimateM, setChordEstimateM] = useState<number | null>(null);

  return (
    <>
      <Viewport />
      <ToolNav />
      <UpdateBanner />

      {/* One scrolling column per side, not several independently-floating
       * boxes: panel content height varies a lot with what's loaded, and
       * separate top-anchored boxes could grow tall enough to collide.
       * Anchoring top AND bottom and scrolling internally makes that
       * collision structurally impossible instead of just unlikely. */}
      <div className="fixed top-16 right-3 bottom-3 z-10 flex w-72 flex-col gap-6 overflow-y-auto">
        <Section label="Model">
          <ImportPanel onMeshSummaryChange={(summary: ImportSummary | null) => setChordEstimateM(summary?.chord_estimate_m ?? null)} />
        </Section>
        <Section label="Aerodynamics">
          <FlightConditionPanel chordEstimateM={chordEstimateM} />
          <StabilityPanel />
        </Section>
      </div>

      <div className="fixed top-16 bottom-3 left-3 z-10 flex w-64 flex-col gap-6 overflow-y-auto">
        <Section label="Flow Field">
          <SolvePanel />
          <VisualizationPanel />
        </Section>
      </div>
    </>
  );
}
