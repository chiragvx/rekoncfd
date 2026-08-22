interface Shot {
  src: string;
  alt: string;
  caption: string;
}

const FEATURED: Shot = {
  src: "/screenshots/product-tool-flow.jpg",
  alt: "Rekon's 3D tool view showing a tapered swept flying wing with surface pressure coloring and lattice-Boltzmann streamlines flowing around it, alongside live CL/CDi/Cm readouts",
  caption: "Live 3D solve — surface pressure, streamlines, and CL/CDi/Cm update as you fly the wing.",
};

const SECONDARY: Shot[] = [
  {
    src: "/screenshots/product-tool-contour.jpg",
    alt: "Rekon's speed contour plane visualization cutting through the flow field around a flying wing",
    caption: "Speed contour plane — a full cross-section of the lattice-Boltzmann flow field.",
  },
  {
    src: "/screenshots/product-explore.jpg",
    alt: "Rekon's Explore Models gallery showing ready-to-fly sample flying-wing planforms",
    caption: "Explore Models — one click loads a planform straight into the tool.",
  },
  {
    src: "/screenshots/product-airfoils.jpg",
    alt: "Rekon's Airfoil Generator showing a NACA 4-digit section and wing planform controls",
    caption: "Airfoil Generator — design a NACA section and extrude it into a full wing.",
  },
];

/** A "browser chrome" frame around each screenshot -- reads as a real
 * captured screen rather than a floating raw image, and keeps every shot at
 * a consistent presentation regardless of its own aspect ratio. */
function ScreenFrame({ shot, className }: { shot: Shot; className?: string }) {
  return (
    <figure className={className}>
      <div className="border-border/60 bg-card surface-elevated overflow-hidden rounded-xl border">
        <div className="border-border/60 bg-background/60 flex items-center gap-1.5 border-b px-3 py-2">
          <span className="size-2 rounded-full bg-[#ff5f57]" />
          <span className="size-2 rounded-full bg-[#febc2e]" />
          <span className="size-2 rounded-full bg-[#28c840]" />
        </div>
        <img src={shot.src} alt={shot.alt} loading="lazy" className="aspect-video w-full object-cover object-top" />
      </div>
      <figcaption className="text-muted-foreground mt-3 text-sm text-balance">{shot.caption}</figcaption>
    </figure>
  );
}

export function ProductScreenshots() {
  return (
    <section aria-labelledby="screenshots-heading" className="mx-auto max-w-6xl px-6 pb-28">
      <div className="mb-10 flex flex-col gap-3">
        <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">See it in action</span>
        <h2 id="screenshots-heading" className="text-3xl font-medium tracking-tight text-balance">
          Real solves, real screens
        </h2>
        <p className="text-muted-foreground max-w-2xl text-balance">
          Every screenshot below is the actual tool, mid-solve — not a mockup.
        </p>
      </div>

      <ScreenFrame shot={FEATURED} />

      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-3">
        {SECONDARY.map((shot) => (
          <ScreenFrame key={shot.src} shot={shot} />
        ))}
      </div>
    </section>
  );
}
