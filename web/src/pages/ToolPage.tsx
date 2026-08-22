import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import type { ImportSummary } from "@/lib/engine";
import { AuthProvider, useAuth } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase";
import { Viewport } from "@/components/Viewport";
import { ToolNav } from "@/components/ToolNav";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DownloadPromptModal } from "@/components/DownloadPromptModal";
import { CoachMarks } from "@/components/CoachMarks";
import { SignInGate } from "@/components/SignInGate";
import { ViewportToolbar } from "@/components/ViewportToolbar";
import { OutputBar } from "@/components/OutputBar";
import { ImportPanel } from "@/components/ImportPanel";
import { FlightConditionPanel } from "@/components/FlightConditionPanel";
import { StabilityPanel } from "@/components/StabilityPanel";
import { SweepAnimationPanel } from "@/components/SweepAnimationPanel";
import { VisualizationPanel } from "@/components/VisualizationPanel";
import { SolvePanel } from "@/components/SolvePanel";
import { SaveProjectPanel } from "@/components/SaveProjectPanel";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/** Groups a cluster of related panels under a small uppercase label that
 * doubles as a collapse toggle -- "make things collapsed by choice" means
 * each group (Model / Aerodynamics / Flow Field) can be closed independently
 * to keep the sidebar as short as the user wants, rather than always
 * showing every panel's full contents. Defaults open. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 px-1 transition-colors">
        <span className="bg-primary/70 h-px w-3 shrink-0" />
        <span className="font-data flex-1 text-left text-[11px] font-medium tracking-[0.15em] uppercase">
          {label}
        </span>
        <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Sidebar({ children }: { children: ReactNode }) {
  return <aside className="flex w-72 shrink-0 flex-col gap-6 overflow-y-auto">{children}</aside>;
}

export function ToolPage() {
  return (
    <AuthProvider>
      <ToolPageGate />
    </AuthProvider>
  );
}

/** Sign-in is required to use the tool at all -- applies equally to the
 * hosted web build and the desktop .exe, since both run this exact same
 * route. Only actually enforced when a Supabase project is connected
 * (`isSupabaseConfigured`): a build with no Supabase project has no way for
 * anyone to ever sign in, so it falls back to open access rather than
 * permanently locking everyone out. */
function ToolPageGate() {
  const { user, loading } = useAuth();

  if (isSupabaseConfigured && loading) {
    return <div className="bg-background fixed inset-0" />;
  }
  if (isSupabaseConfigured && !user) {
    return <SignInGate />;
  }
  return <ToolPageContent />;
}

function ToolPageContent() {
  const [chordEstimateM, setChordEstimateM] = useState<number | null>(null);

  return (
    <div className="fixed inset-0 flex flex-col">
      <ToolNav />
      <UpdateBanner />
      <DownloadPromptModal />
      <CoachMarks />

      <div className="flex flex-1 gap-4 overflow-hidden px-4 pb-4 pt-[4.5rem]">
        <Sidebar>
          <Section label="Flow Field">
            <SolvePanel />
            <VisualizationPanel />
          </Section>
        </Sidebar>

        <div className="relative flex min-w-0 flex-1 flex-col gap-4">
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-[32px] border">
            <Viewport />
            <ViewportToolbar />
          </div>
          <OutputBar />
        </div>

        <Sidebar>
          <Section label="Model">
            <ImportPanel
              onMeshSummaryChange={(summary: ImportSummary | null) => setChordEstimateM(summary?.chord_estimate_m ?? null)}
            />
          </Section>
          <Section label="Aerodynamics">
            <FlightConditionPanel chordEstimateM={chordEstimateM} />
            <StabilityPanel />
          </Section>
          <Section label="Animation">
            <SweepAnimationPanel />
          </Section>
          {isSupabaseConfigured && (
            <Section label="Account">
              <SaveProjectPanel />
            </Section>
          )}
        </Sidebar>
      </div>
    </div>
  );
}
