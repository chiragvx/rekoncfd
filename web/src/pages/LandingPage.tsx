import { Link } from "react-router-dom";
import {
  ArrowRight,
  Download,
  Gauge,
  Globe,
  LineChart,
  MonitorSmartphone,
  MousePointerClick,
  Play,
  Ruler,
  ScanLine,
  Sparkles,
  Upload,
  Wind,
} from "lucide-react";

import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { RekonMark } from "@/components/RekonMark";
import { ProductScreenshots } from "@/components/ProductScreenshots";
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

const STEPS = [
  {
    icon: Upload,
    title: "Bring a wing",
    body: "Import an STL, load a sample from Explore Models, or design one from scratch with the NACA airfoil + wing generator.",
  },
  {
    icon: MousePointerClick,
    title: "Set the flight condition",
    body: "Drag angle of attack, airspeed, and CG. The panel method re-solves live, so CL/CDi/Cm update as you move each slider.",
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

const STATS = [
  { icon: Globe, label: "Runs offline", detail: "Desktop app solves entirely on your own machine, no account, no upload." },
  { icon: Download, label: "Self-updating", detail: "One .exe, no installer — it checks GitHub Releases and updates itself." },
  { icon: MonitorSmartphone, label: "Browser or desktop", detail: "Preview the UI on the web, or run the full solver locally." },
];

const FAQS = [
  {
    q: "Is Rekon free?",
    a: "Yes. Both the hosted web preview and the downloadable Windows desktop app are free, with no account required.",
  },
  {
    q: "Do I need an internet connection to use it?",
    a: "The hosted page at rekoncfd.vercel.app is a preview shell with no backend of its own — it can't actually solve anything. The downloaded desktop app runs a local server on your own machine and solves fully offline; it only touches the network to check for a new version on launch.",
  },
  {
    q: "What file formats can I import?",
    a: "STL. If the auto-detected orientation or unit is wrong, you can override the axis mapping and unit manually after import. You can also skip import entirely and generate a wing from a NACA 4- or 5-digit airfoil section.",
  },
  {
    q: "How accurate is the solver?",
    a: "Rekon uses a source-doublet panel method for lift, drag, and moment, plus a D3Q19 lattice-Boltzmann solver for the 3D flow field. It's accurate enough to guide real design decisions on typical thin-to-moderate-thickness RC flying-wing planforms — tapered, swept, twisted — though like any panel method it's best suited to lifting surfaces rather than bluff bodies.",
  },
  {
    q: "Is Rekon open source?",
    a: "Yes, the full source is available on GitHub at github.com/chiragvx/rekoncfd.",
  },
  {
    q: "What platforms does the desktop app support?",
    a: "Windows, as a single standalone .exe with no installer or admin rights required.",
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

export function LandingPage() {
  return (
    <div className="bg-background min-h-screen">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }} />

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
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
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

      <ProductScreenshots />

      <section aria-labelledby="features-heading" className="mx-auto max-w-6xl px-6 pb-28">
        <div className="mb-10 flex flex-col gap-3">
          <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">What's inside</span>
          <h2 id="features-heading" className="text-3xl font-medium tracking-tight text-balance">
            Everything a flying wing needs
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
        </div>
      </section>

      <section aria-labelledby="how-it-works-heading" className="border-border/60 border-y">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div className="mb-12 flex flex-col gap-3">
            <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">How it works</span>
            <h2 id="how-it-works-heading" className="text-3xl font-medium tracking-tight text-balance">
              From geometry to real numbers, in one session
            </h2>
          </div>
          <ol className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex flex-col gap-3">
                <div className="text-muted-foreground/60 font-data flex items-center gap-3 text-xs tracking-widest">
                  <span className="border-border flex size-8 items-center justify-center rounded-full border">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <step.icon className="text-primary size-5" />
                <h3 className="font-medium tracking-tight">{step.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="stats-heading" className="mx-auto max-w-6xl px-6 py-24">
        <h2 id="stats-heading" className="sr-only">
          Why run Rekon locally
        </h2>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {STATS.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-2">
              <stat.icon className="text-primary size-5" />
              <span className="font-medium tracking-tight">{stat.label}</span>
              <p className="text-muted-foreground text-sm leading-relaxed">{stat.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="faq-heading" className="border-border/60 border-t">
        <div className="mx-auto max-w-3xl px-6 py-24">
          <div className="mb-10 flex flex-col gap-3">
            <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">FAQ</span>
            <h2 id="faq-heading" className="text-3xl font-medium tracking-tight text-balance">
              Questions people actually ask
            </h2>
          </div>
          <dl className="flex flex-col gap-8">
            {FAQS.map((f) => (
              <div key={f.q}>
                <dt className="font-medium tracking-tight">{f.q}</dt>
                <dd className="text-muted-foreground mt-2 text-sm leading-relaxed">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="glow-primary border-border/60 border-t">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 py-24 text-center">
          <h2 className="text-3xl font-medium tracking-tight text-balance">Ready to see how your wing actually flies?</h2>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link to="/tool">
                Open the Tool <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/download">Download for Windows</Link>
            </Button>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
