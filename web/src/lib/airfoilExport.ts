/**
 * Client-side export of the currently-previewed airfoil section -- pure data
 * transforms over `sampleAirfoil`'s already-computed points, no server round
 * trip needed (this only ever exports the 2D section, not the extruded
 * wing -- that's what "Generate & Open in Tool" plus the main tool's own
 * export path is for).
 */

import { sampleAirfoil, type PreviewAirfoil } from "@/lib/airfoilPreview";
import { drawAirfoilToCanvas } from "@/components/AirfoilPreview";

export type DatFormat = "selig" | "lednicer" | "surfaces";

const DAT_FORMAT_LABELS: Record<DatFormat, string> = {
  selig: "Selig (name + single x y loop)",
  lednicer: "Lednicer (upper/lower, count header)",
  surfaces: "Original (name + x y, per-surface blocks)",
};

export const DAT_FORMATS: DatFormat[] = ["surfaces", "selig", "lednicer"];
export { DAT_FORMAT_LABELS };

function fmt(n: number): string {
  return n.toFixed(6);
}

/** Selig convention: a single closed loop, trailing edge -> upper surface ->
 * leading edge -> lower surface -> trailing edge, one `x y` pair per line. */
function toSelig(name: string, upper: [number, number][], lower: [number, number][]): string {
  const lines = [name];
  for (let i = upper.length - 1; i >= 0; i--) lines.push(`${fmt(upper[i][0])} ${fmt(upper[i][1])}`);
  for (let i = 1; i < lower.length; i++) lines.push(`${fmt(lower[i][0])} ${fmt(lower[i][1])}`);
  return lines.join("\n") + "\n";
}

/** Lednicer convention: a point-count header, then the upper surface leading
 * edge -> trailing edge, a blank separator line, then the lower surface
 * leading edge -> trailing edge. */
function toLednicer(name: string, upper: [number, number][], lower: [number, number][]): string {
  const lines = [name, `${upper.length}. ${lower.length}.`];
  for (const [x, y] of upper) lines.push(`${fmt(x)} ${fmt(y)}`);
  lines.push("");
  for (const [x, y] of lower) lines.push(`${fmt(x)} ${fmt(y)}`);
  return lines.join("\n") + "\n";
}

/** Same per-surface leading-edge-to-trailing-edge ordering as Lednicer, but
 * without the count header -- the two-block shape most CAD spline-import
 * tools (Fusion 360 included) expect from a pasted point list. */
function toSurfaceBlocks(name: string, upper: [number, number][], lower: [number, number][]): string {
  const lines = [name];
  for (const [x, y] of upper) lines.push(`${fmt(x)} ${fmt(y)}`);
  lines.push("");
  for (const [x, y] of lower) lines.push(`${fmt(x)} ${fmt(y)}`);
  return lines.join("\n") + "\n";
}

export function buildDat(designation: string, airfoil: PreviewAirfoil, format: DatFormat, points = 100): string {
  const { upper, lower } = sampleAirfoil(airfoil, points);
  const name = `NACA ${designation}`;
  if (format === "selig") return toSelig(name, upper, lower);
  if (format === "lednicer") return toLednicer(name, upper, lower);
  return toSurfaceBlocks(name, upper, lower);
}

export function buildCsv(designation: string, airfoil: PreviewAirfoil, points = 100): string {
  const { upper, lower } = sampleAirfoil(airfoil, points);
  const lines = [`# NACA ${designation}`, "surface,x,y"];
  for (let i = upper.length - 1; i >= 0; i--) lines.push(`upper,${fmt(upper[i][0])},${fmt(upper[i][1])}`);
  for (const [x, y] of lower) lines.push(`lower,${fmt(x)},${fmt(y)}`);
  return lines.join("\n") + "\n";
}

export function buildSvg(designation: string, airfoil: PreviewAirfoil, points = 160): string {
  const { upper, lower } = sampleAirfoil(airfoil, points);
  const W = 1000;
  const H = 500;
  const pad = 24;
  const scale = W - pad * 2;
  const originX = pad;
  const originY = H / 2;
  const toSvg = ([x, y]: [number, number]) => `${(originX + x * scale).toFixed(2)},${(originY - y * scale).toFixed(2)}`;

  const loop = [...upper.slice().reverse(), ...lower.slice(1)];
  const pathD = loop.map((p, i) => `${i === 0 ? "M" : "L"} ${toSvg(p)}`).join(" ") + " Z";

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<rect width="${W}" height="${H}" fill="#0a0a0f"/>`,
    `<line x1="${originX}" y1="${originY}" x2="${originX + scale}" y2="${originY}" stroke="#ffffff" stroke-opacity="0.15" stroke-width="1"/>`,
    `<path d="${pathD}" fill="#6fb3ff" fill-opacity="0.14" stroke="#6fb3ff" stroke-width="2.5" stroke-linejoin="round"/>`,
    `<text x="${pad}" y="${H - 12}" fill="#ffffff" fill-opacity="0.5" font-family="monospace" font-size="16">NACA ${designation}</text>`,
    `</svg>`,
  ].join("\n");
}

export function downloadTextFile(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Renders the airfoil into a dedicated off-DOM canvas at export resolution
 * (independent of whatever size the on-page preview happens to be) and saves
 * it as a PNG -- shares `drawAirfoilToCanvas` with the live preview so the
 * two never visually drift apart. */
export async function exportPng(designation: string, airfoil: PreviewAirfoil, accentColor: string) {
  const canvas = document.createElement("canvas");
  const width = 1200;
  const height = 600;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  drawAirfoilToCanvas(ctx, airfoil, width, height, accentColor);
  await new Promise<void>((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(`naca-${designation}.png`, blob);
      resolve();
    }, "image/png");
  });
}
