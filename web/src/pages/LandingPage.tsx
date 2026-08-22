import { Link } from "react-router-dom";
import { ArrowRight, Gauge, LineChart, Ruler, ScanLine, Upload, Wind } from "lucide-react";

import { SiteHeader } from "@/components/SiteHeader";
import { RekonMark } from "@/components/RekonMark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const FEATURES = [
  {
    icon: Gauge,
    title: "Live panel-method solve",
    body: "Drag angle of attack, airspeed, or CG and watch CL/CDi/Cm update in real time from a cached-LU source-doublet panel model.",
  },
  {
    icon: Wind,
    title: "On-demand flow field",
    body: "A D3Q19 lattice-Boltzmann solve renders pressure, OpenFOAM-style streamlines, vorticity hotspots, and a speed contour plane.",
  },
  {
    icon: LineChart,
    title: "Trim & stability",
    body: "Bisection trim search, static margin about your CG, and full alpha-sweep polars for CL, CDi, and Cm.",
  },
  {
    icon: Upload,
    title: "Bring your own STL",
    body: "Drop in a wing, override the guessed unit and axis mapping if needed, and it's ready to fly in seconds.",
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

const SPECS = ["Source-doublet panel method", "D3Q19 lattice-Boltzmann", "NACA 4/5-digit generator", "Cached-LU re-solve"];

export function LandingPage() {
  return (
    <div className="bg-background min-h-screen">
      <SiteHeader />

      <section className="glow-primary relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage: "radial-gradient(ellipse 60% 55% at 50% 0%, black, transparent)",
          }}
        />

        <div className="relative mx-auto flex max-w-4xl flex-col items-center gap-7 px-6 pt-28 pb-20 text-center">
          <RekonMark className="text-primary size-12 drop-shadow-[0_0_24px_hsl(var(--primary)/0.45)]" />
          <span className="border-border/80 text-muted-foreground font-data flex items-center gap-2 rounded-full border px-3 py-1 text-[0.7rem] tracking-[0.15em] uppercase">
            <span className="bg-success size-1.5 rounded-full" />
            RC flying-wing CFD, in the browser
          </span>
          <h1 className="text-6xl leading-[1.05] font-medium text-balance sm:text-7xl">
            Design, trim, and
            <br />
            see the flow.
          </h1>
          <p className="text-muted-foreground max-w-xl text-lg text-balance">
            Rekon combines a live 3D panel-method solver with an on-demand lattice-Boltzmann flow field, so a
            tapered, swept flying wing gets real lift, drag, trim, and stability numbers — before you cut foam.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <Button asChild size="lg">
              <Link to="/tool">
                Open the Tool <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/airfoils">Generate an Airfoil</Link>
            </Button>
          </div>

          <div className="text-muted-foreground/70 mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            {SPECS.map((s) => (
              <span key={s} className="font-data text-[0.7rem] tracking-wide">
                {s}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl grid-cols-1 gap-4 px-6 pb-28 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <Card key={f.title} className="surface-interactive gap-3">
            <CardHeader>
              <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-lg">
                <f.icon className="size-5" />
              </div>
              <CardTitle className="mt-3 text-[0.95rem] tracking-tight">{f.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm leading-relaxed">{f.body}</p>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
