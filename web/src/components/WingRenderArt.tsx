/** A stylized flying-wing render for the download prompt's hero art -- built
 * as an inline SVG in Rekon's own dark/blue palette (not a real product
 * photo, which this project has none of) so it reads as "a render from the
 * tool itself" rather than generic marketing stock art. The silhouette
 * mirrors the center-notch swept planform the app's own sample models use. */
export function WingRenderArt() {
  return (
    <div className="relative flex h-44 items-center justify-center overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(60% 70% at 50% 45%, hsl(var(--primary) / 0.28), transparent 75%)" }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
          maskImage: "radial-gradient(ellipse 70% 70% at 50% 50%, black, transparent)",
        }}
      />
      <svg viewBox="0 0 100 60" className="relative h-32 w-auto drop-shadow-[0_8px_24px_hsl(var(--primary)/0.35)]">
        <defs>
          <linearGradient id="wingFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.95" />
            <stop offset="55%" stopColor="hsl(var(--primary))" stopOpacity="0.55" />
            <stop offset="100%" stopColor="hsl(224 20% 16%)" stopOpacity="0.9" />
          </linearGradient>
          <linearGradient id="wingEdge" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0" />
            <stop offset="50%" stopColor="hsl(var(--primary))" stopOpacity="0.9" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
          </linearGradient>
        </defs>

        <polygon
          points="50,4 93,42 60,50 50,42 40,50 7,42"
          fill="url(#wingFill)"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.7"
          strokeWidth="0.5"
        />

        {/* Cp-style contour bands across the surface */}
        {[13, 20, 27, 34].map((y) => (
          <path
            key={y}
            d={`M ${7 + (y - 4) * 0.47} ${y} L ${93 - (y - 4) * 0.47} ${y}`}
            stroke="hsl(226 24% 4%)"
            strokeOpacity="0.35"
            strokeWidth="0.4"
          />
        ))}

        {/* Centerline highlight */}
        <line x1="50" y1="4" x2="50" y2="42" stroke="url(#wingEdge)" strokeWidth="0.6" />
      </svg>
    </div>
  );
}
