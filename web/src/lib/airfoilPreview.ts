/**
 * Client-side mirror of `rekon_geometry::naca`'s math, for the Airfoil
 * Generator's instant 2D preview only — NOT the source of truth for the
 * actual generated mesh (that's always the Rust server, via
 * `POST /api/mesh/generate`), so this only needs to look right, not be the
 * authoritative geometry.
 */

export type Naca4Params = { camber: number; camberPos: number; thickness: number };
export type Naca5Params = { designCl: number; camberPosCode: 1 | 2 | 3 | 4 | 5; thickness: number };

const NACA5_TABLE: Record<1 | 2 | 3 | 4 | 5, { r: number; k1: number }> = {
  1: { r: 0.058, k1: 361.4 },
  2: { r: 0.126, k1: 51.64 },
  3: { r: 0.2025, k1: 15.957 },
  4: { r: 0.29, k1: 6.643 },
  5: { r: 0.391, k1: 3.23 },
};

function halfThickness(t: number, x: number): number {
  return 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1036 * x ** 4);
}

function naca4Camber(m: number, p: number, x: number): [number, number] {
  if (m === 0 || p === 0) return [0, 0];
  if (x < p) {
    return [(m / p ** 2) * (2 * p * x - x * x), ((2 * m) / p ** 2) * (p - x)];
  }
  return [(m / (1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x * x), ((2 * m) / (1 - p) ** 2) * (p - x)];
}

function naca5Camber(designCl: number, code: 1 | 2 | 3 | 4 | 5, x: number): [number, number] {
  const { r, k1 } = NACA5_TABLE[code];
  const scale = designCl / 0.3;
  if (x < r) {
    return [
      scale * (k1 / 6) * (x ** 3 - 3 * r * x * x + r * r * (3 - r) * x),
      scale * (k1 / 6) * (3 * x * x - 6 * r * x + r * r * (3 - r)),
    ];
  }
  return [scale * (k1 / 6) * r ** 3 * (1 - x), scale * (-k1 / 6) * r ** 3];
}

export type PreviewAirfoil = { kind: "naca4"; params: Naca4Params } | { kind: "naca5"; params: Naca5Params };

export type ParsedDesignation =
  | { family: "naca4"; camber: number; camberPos: number; thickness: number }
  | { family: "naca5"; l: number; p: 1 | 2 | 3 | 4 | 5; thickness: number };

/** Parses a bare NACA digit string ("2412", "23012" -- no "NACA" prefix) the
 * same way `rekon_geometry::naca::Airfoil::parse_naca` does, for the
 * designation text input's live validation. Returns `null` for anything the
 * generator can't build (wrong length, non-digits, reflexed 5-digit codes,
 * unsupported camber-position codes, or an out-of-range thickness) rather
 * than guessing -- same "reject, don't guess" rule the Rust side follows. */
export function parseNacaDesignation(input: string): ParsedDesignation | null {
  const s = input.trim();
  if (s.length === 0 || !/^\d+$/.test(s)) return null;
  const digits = s.split("").map(Number);

  if (digits.length === 4) {
    const thickness = digits[2] * 10 + digits[3];
    if (!(thickness > 0 && thickness < 40)) return null;
    return { family: "naca4", camber: digits[0], camberPos: digits[1], thickness };
  }
  if (digits.length === 5) {
    const [l, p, q] = digits;
    if (q !== 0) return null;
    if (!(p >= 1 && p <= 5)) return null;
    const thickness = digits[3] * 10 + digits[4];
    if (!(thickness > 0 && thickness < 40)) return null;
    return { family: "naca5", l, p: p as 1 | 2 | 3 | 4 | 5, thickness };
  }
  return null;
}

/** Returns [upper, lower] points (each `[x, y]`, unit chord) sampled with
 * cosine chordwise clustering — matching the server's actual construction. */
export function sampleAirfoil(airfoil: PreviewAirfoil, n = 80): { upper: [number, number][]; lower: [number, number][] } {
  const thickness = airfoil.kind === "naca4" ? airfoil.params.thickness : airfoil.params.thickness;
  const upper: [number, number][] = [];
  const lower: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    const x = 0.5 * (1 - Math.cos(s * Math.PI));
    const yt = halfThickness(thickness, x);
    const [yc, dyc] =
      airfoil.kind === "naca4"
        ? naca4Camber(airfoil.params.camber, airfoil.params.camberPos, x)
        : naca5Camber(airfoil.params.designCl, airfoil.params.camberPosCode, x);
    const theta = Math.atan(dyc);
    upper.push([x - yt * Math.sin(theta), yc + yt * Math.cos(theta)]);
    lower.push([x + yt * Math.sin(theta), yc - yt * Math.cos(theta)]);
  }
  return { upper, lower };
}
