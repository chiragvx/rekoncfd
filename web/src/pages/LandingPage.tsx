import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ArrowRight,
  Download,
  Gauge,
  LineChart,
  MonitorPlay,
  MousePointerClick,
  Play,
  Ruler,
  ScanLine,
  Sparkles,
  Upload,
  Wind,
  type LucideIcon,
} from "lucide-react";

import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { RekonMark } from "@/components/RekonMark";
import { FaqSection, FAQS } from "@/components/FaqSection";
import { DownloadSection } from "@/components/DownloadSection";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SPEC_ROWS = [
  { metric: "Lift, drag, moment", method: "Source-doublet panel method, cached LU", speed: "Instant, every drag" },
  { metric: "Trim angle", method: "Bisection search on Cm(α)", speed: "Instant" },
  { metric: "Static margin", method: "About your current CG", speed: "Instant" },
  { metric: "Alpha-sweep polar", method: "Up to 200 points", speed: "A few seconds" },
  { metric: "Pressure, streamlines, vorticity", method: "D3Q19 lattice-Boltzmann", speed: "On-demand, under a minute" },
];

const STEPS = [
  {
    icon: Upload,
    title: "Bring a wing",
    body: "Import an STL, load a sample from Explore Models, or design one from scratch with the NACA airfoil + wing generator.",
  },
  {
    icon: MousePointerClick,
    title: "Set the flight condition",
    body: "Drag angle of attack, airspeed, bank, or CG — the panel method re-solves live, so CL/CDi/Cm update as you move each slider.",
  },
  {
    icon: Play,
    title: "Solve the flow field",
    body: "Kick off an on-demand lattice-Boltzmann solve for real pressure, streamlines, vorticity, and a speed contour plane.",
  },
  {
    icon: Sparkles,
    title: "Trim, sweep, and bank",
    body: "Find the trim angle, run a full alpha-sweep polar, or set a real bank angle and re-solve at that orientation.",
  },
];

interface FeatureTile {
  icon: LucideIcon;
  title: string;
  body: string;
}

const FEATURES: FeatureTile[] = [
  {
    icon: Gauge,
    title: "Live panel-method solve",
    body: "Drag angle of attack, airspeed, bank, or CG and watch CL/CDi/Cm update in real time from a cached-LU source-doublet panel model.",
  },
  {
    icon: Wind,
    title: "On-demand flow field",
    body: "A D3Q19 lattice-Boltzmann solve renders pressure, OpenFOAM-style streamlines, vorticity hotspots, and a speed contour plane — genuinely computed, not painted on.",
  },
  {
    icon: LineChart,
    title: "Trim & stability",
    body: "Bisection trim search, static margin about your CG, and full alpha-sweep polars for CL, CDi, and Cm.",
  },
  {
    icon: Upload,
    title: "Bring your own STL",
    body: "Drop in a wing and it's ready to fly in seconds — orientation and units are detected automatically.",
  },
  {
    icon: Ruler,
    title: "Airfoil & wing generator",
    body: "Design a NACA 4- or 5-digit section and extrude it into a tapered, swept, twisted wing — no CAD required.",
  },
  {
    icon: ScanLine,
    title: "Explore Models",
    body: "Browse a growing gallery of ready-to-fly planforms and drop straight into the tool with one click.",
  },
];

const SETUP_STEPS = [
  {
    icon: Download,
    title: "Download",
    body: "Grab the standalone app for Windows or macOS, or skip straight to the hosted preview in your browser.",
  },
  {
    icon: MonitorPlay,
    title: "Launch",
    body: "No installer, no admin rights. It opens straight into your own browser at 127.0.0.1, then a quick free sign-in — same account either way — and it stays there.",
  },
  {
    icon: Sparkles,
    title: "You're flying",
    body: "Import a wing, generate one, or load a sample from Explore Models — the sliders are live immediately.",
  },
];

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQS.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
};

function Rule({ className }: { className?: string }) {
  return <div className={cn("rule-blueprint mx-auto max-w-6xl", className)} />;
}

export function LandingPage() {
  // Client-side routing doesn't auto-scroll to a URL hash the way a full
  // page load does -- needed both for in-page nav links (SiteHeader's
  // "Download" now points at #download) and for the deprecated /download
  // route's redirect (see App.tsx) to actually land on this section.
  // Watching `location.hash` (not just running once on mount) matters when
  // already ON the homepage: clicking "Download" there doesn't remount this
  // component at all, only changes the hash.
  const location = useLocation();
  useEffect(() => {
    if (!location.hash) return;
    const el = document.querySelector(location.hash);
    el?.scrollIntoView({ behavior: "smooth" });
  }, [location.hash]);

  return (
    <div className="bg-background min-h-screen">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }} />

      <SiteHeader />

      {/* ---------- Hero ---------- */}
      <section className="glow-primary relative overflow-hidden">
        <div className="relative mx-auto flex max-w-4xl flex-col items-center gap-6 px-6 pt-24 pb-4 text-center">
          <RekonMark className="text-primary size-12 drop-shadow-[0_0_24px_hsl(var(--primary)/0.45)]" />
          <span className="border-border/80 text-muted-foreground font-data flex items-center gap-2 rounded-full border px-3 py-1 text-[0.7rem] tracking-[0.15em] uppercase">
            <span className="bg-success size-1.5 rounded-full" />
            Free · open source · runs offline
          </span>
          <h1 className="text-6xl leading-[1.05] font-medium text-balance sm:text-7xl">Real aerodynamics for the RC hobbyist.</h1>
          <p className="text-muted-foreground max-w-xl text-lg text-balance">
            Rekon combines a live 3D panel-method solver with an on-demand lattice-Boltzmann flow field, so a
            tapered, swept flying wing gets real lift, drag, trim, and stability numbers — before you cut foam.
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link to="/tool">
                Open the Tool <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/airfoils">Generate an Airfoil</Link>
            </Button>
          </div>
        </div>

        <div className="relative mx-auto mt-10 max-w-6xl px-4 pb-16 sm:px-6">
          <div className="border-border/60 surface-elevated relative overflow-hidden rounded-2xl border">
            <img
              src="/screenshots/product-tool-flow.jpg"
              alt="Rekon's 3D tool view showing a tapered swept flying wing with surface pressure coloring and lattice-Boltzmann streamlines flowing around it, alongside live CL/CDi/Cm readouts"
              className="block w-full"
            />
          </div>

          <div className="text-muted-foreground/80 mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-2">
            <span className="font-data text-xs tracking-wide">
              CL <strong className="text-foreground">1.305</strong>
            </span>
            <span className="font-data text-xs tracking-wide">
              CDi <strong className="text-foreground">0.0552</strong>
            </span>
            <span className="font-data text-xs tracking-wide">
              Cm <strong className="text-foreground">0.034</strong>
            </span>
            <span className="text-muted-foreground/60 text-xs">— actual solver output, not a mockup</span>
          </div>
        </div>
      </section>

      <Rule />

      {/* ---------- Two solvers, one session ---------- */}
      <section aria-labelledby="solvers-heading" className="mx-auto max-w-6xl px-6 py-24">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-5">
          <div className="flex flex-col gap-4 lg:col-span-2">
            <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">How it solves</span>
            <h2 id="solvers-heading" className="text-3xl font-medium tracking-tight text-balance">
              Two solvers, built for two different jobs.
            </h2>
            <p className="text-muted-foreground leading-relaxed text-balance">
              Dragging a slider shouldn't mean waiting. The panel method factorizes once per mesh and re-solves
              every angle-of-attack, airspeed, bank, or CG change from a cached LU decomposition — lift, drag, and
              moment update as fast as you can move your mouse. When you actually want to see the air, an on-demand
              lattice-Boltzmann solve renders real pressure, streamlines, and vorticity, genuinely computed for this
              exact wing and condition.
            </p>
          </div>

          <div className="border-border/60 bg-card/40 overflow-hidden rounded-xl border lg:col-span-3">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-border/60 text-muted-foreground border-b text-xs tracking-wide uppercase">
                  <th className="px-4 py-3 font-medium">Metric</th>
                  <th className="hidden px-4 py-3 font-medium sm:table-cell">Method</th>
                  <th className="px-4 py-3 text-right font-medium">Speed</th>
                </tr>
              </thead>
              <tbody className="font-data">
                {SPEC_ROWS.map((row, i) => (
                  <tr key={row.metric} className={cn("text-sm", i > 0 && "border-border/40 border-t")}>
                    <td className="px-4 py-3 font-medium">{row.metric}</td>
                    <td className="text-muted-foreground hidden px-4 py-3 sm:table-cell">{row.method}</td>
                    <td className="text-primary px-4 py-3 text-right whitespace-nowrap">{row.speed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <Rule />

      {/* ---------- How it works ---------- */}
      <section aria-labelledby="how-it-works-heading" className="mx-auto max-w-6xl px-6 py-24">
        <div className="mb-12 flex flex-col gap-3">
          <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">How it works</span>
          <h2 id="how-it-works-heading" className="text-3xl font-medium tracking-tight text-balance">
            From geometry to real numbers, in one session
          </h2>
        </div>
        <ol className="flex flex-col gap-10 sm:flex-row sm:items-start sm:gap-0">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex flex-1 flex-col gap-3 sm:pr-6">
              <div className="flex items-center gap-3">
                <span className="border-border text-muted-foreground font-data flex size-8 shrink-0 items-center justify-center rounded-full border text-xs tracking-widest">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {i < STEPS.length - 1 && <span className="rule-blueprint hidden flex-1 sm:block" />}
              </div>
              <step.icon className="text-primary size-5" />
              <h3 className="font-medium tracking-tight">{step.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <Rule />

      {/* ---------- What's inside (bento) ---------- */}
      <section aria-labelledby="features-heading" className="mx-auto max-w-6xl px-6 py-24">
        <div className="mb-10 flex flex-col gap-3">
          <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">What's inside</span>
          <h2 id="features-heading" className="text-3xl font-medium tracking-tight text-balance">
            Everything a flying wing needs
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="surface-interactive border-border/60 bg-card gap-3 rounded-xl border p-5">
              <div className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
                <f.icon className="size-4.5" />
              </div>
              <h3 className="mt-3 text-[0.95rem] font-medium tracking-tight">{f.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <FaqSection />

      {/* ---------- Getting started ---------- */}
      <section aria-labelledby="setup-heading" className="mx-auto max-w-6xl px-6 pt-24 pb-4">
        <div className="mb-10 flex flex-col gap-3">
          <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">Getting started</span>
          <h2 id="setup-heading" className="text-3xl font-medium tracking-tight text-balance">
            Running in under a minute
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-3">
          {SETUP_STEPS.map((step, i) => (
            <div key={step.title} className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <div className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
                  <step.icon className="size-4.5" />
                </div>
                <span className="font-data text-muted-foreground/60 text-xs tracking-widest">
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="font-medium tracking-tight">{step.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <DownloadSection />

      <SiteFooter />
    </div>
  );
}
