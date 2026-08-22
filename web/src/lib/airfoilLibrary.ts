/**
 * Curated NACA presets for the Airfoil Generator's library sidebar --
 * one-click starting points instead of dialing in every slider from scratch.
 * Every entry is a genuine NACA 4- or 5-digit designation (the only families
 * `rekon_geometry::naca` generates with confidence today -- see that
 * module's doc comment); 6-series laminar-flow presets will follow once
 * real tabulated thickness data backs that family.
 */

import type { PreviewAirfoil } from "@/lib/airfoilPreview";

export type LibraryEntry = {
  designation: string;
  name: string;
  airfoil: PreviewAirfoil;
};

export type LibraryCategory = {
  key: string;
  label: string;
  heading: string;
  entries: LibraryEntry[];
};

function naca4(designation: string, name: string): LibraryEntry {
  const d = designation.split("").map(Number);
  const camber = d[0] / 100;
  const camberPos = camber === 0 ? 0 : d[1] / 10;
  const thickness = (d[2] * 10 + d[3]) / 100;
  return { designation, name, airfoil: { kind: "naca4", params: { camber, camberPos, thickness } } };
}

function naca5(designation: string, name: string): LibraryEntry {
  const d = designation.split("").map(Number);
  const designCl = 0.15 * d[0];
  const camberPosCode = d[1] as 1 | 2 | 3 | 4 | 5;
  const thickness = (d[3] * 10 + d[4]) / 100;
  return { designation, name, airfoil: { kind: "naca5", params: { designCl, camberPosCode, thickness } } };
}

export const AIRFOIL_LIBRARY: LibraryCategory[] = [
  {
    key: "highRe",
    label: "High Re",
    heading: "High-Reynolds profiles (GA & transport)",
    entries: [
      naca4("2412", "Standard GA main wing"),
      naca4("2415", "Utility / cargo root section"),
      naca4("0012", "Symmetric / aerobatic standard"),
      naca4("4412", "High-lift STOL utility"),
      naca4("4415", "Heavy payload utility"),
      naca5("23012", "Modern airliner / transport"),
      naca5("23015", "High-lift cargo transport"),
      naca4("1412", "High-speed efficiency"),
      naca4("0018", "Extreme aerobatic / structural"),
      naca4("2418", "Thick root assembly section"),
    ],
  },
  {
    key: "lowRe",
    label: "Low Re",
    heading: "Low-Reynolds profiles (RC & UAS)",
    entries: [
      naca4("4412", "Heavy lift RC/UAS profile"),
      naca4("4415", "High camber heavy UAS"),
      naca4("2410", "Efficient cruise UAS wing"),
      naca4("1408", "High-speed racing wing"),
      naca4("0010", "Precision symmetric tail fin"),
      naca4("2408", "Ultra-thin high-efficiency wing"),
      naca4("4410", "Balanced high-lift profile"),
      naca4("1410", "Fast utility cruise wing"),
      naca4("3412", "Medium camber scaled wing"),
      naca5("23010", "Thin scaled transport wing"),
    ],
  },
  {
    key: "control",
    label: "Control",
    heading: "Symmetric sections (tails & control surfaces)",
    entries: [
      naca4("0006", "High-speed thin tail surface"),
      naca4("0008", "Ultra-thin tail section"),
      naca4("0009", "Standard control surface, fine"),
      naca4("0012", "General-purpose tail / fin"),
      naca4("0015", "Deep symmetric control surface"),
      naca4("0021", "Thick control blade, standard"),
    ],
  },
];
