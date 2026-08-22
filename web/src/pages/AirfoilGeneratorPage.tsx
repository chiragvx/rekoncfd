import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Download, LoaderCircle, Sparkles, SquareStack } from "lucide-react";

import { engine } from "@/lib/engine";
import { parseNacaDesignation, type PreviewAirfoil } from "@/lib/airfoilPreview";
import { AIRFOIL_LIBRARY, type LibraryEntry } from "@/lib/airfoilLibrary";
import { buildDat, buildCsv, buildSvg, downloadTextFile, exportPng, DAT_FORMATS, DAT_FORMAT_LABELS, type DatFormat } from "@/lib/airfoilExport";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { AirfoilPreview } from "@/components/AirfoilPreview";
import { WingPreview3D } from "@/components/WingPreview3D";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type Family = "naca4" | "naca5" | "naca6";

const FAMILIES: { key: Family; label: string; disabled?: boolean }[] = [
  { key: "naca4", label: "NACA 4-Digit" },
  { key: "naca5", label: "NACA 5-Digit" },
  { key: "naca6", label: "NACA 6-Series", disabled: true },
];

const CAMBER_POS_LABELS: Record<number, string> = { 1: "5%", 2: "10%", 3: "15%", 4: "20%", 5: "25%" };

function Row({ label, value, unit, children }: { label: string; value: string; unit?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-normal">{label}</Label>
        <span className="font-data text-muted-foreground text-xs">
          {value}
          {unit && <span className="ml-0.5">{unit}</span>}
        </span>
      </div>
      {children}
    </div>
  );
}

export function AirfoilGeneratorPage() {
  const navigate = useNavigate();

  const [family, setFamily] = useState<Family>("naca4");

  // NACA 4-digit params: camber (0-9 -> %chord/100... i.e. digit IS the m/100
  // numerator), camber position (0-9, tenths of chord), thickness (1-40, %chord).
  const [n4Camber, setN4Camber] = useState(2);
  const [n4CamberPos, setN4CamberPos] = useState(4);
  const [n4Thickness, setN4Thickness] = useState(12);

  // NACA 5-digit params: L (0-9, design Cl = 0.15*L), P (1-5, camber position
  // code), thickness (1-40, %chord). Reflexed (Q=1) isn't supported yet.
  const [n5L, setN5L] = useState(2);
  const [n5P, setN5P] = useState(3);
  const [n5Thickness, setN5Thickness] = useState(12);

  const [spanM, setSpanM] = useState(1.2);
  const [rootChordM, setRootChordM] = useState(0.28);
  const [tipChordM, setTipChordM] = useState(0.16);
  const [sweepDeg, setSweepDeg] = useState(12);
  const [dihedralDeg, setDihedralDeg] = useState(3);
  const [washoutDeg, setWashoutDeg] = useState(-2);

  const [previewMode, setPreviewMode] = useState<"2d" | "3d">("2d");
  const [renderMode, setRenderMode] = useState<"wireframe" | "solid">("solid");
  const [datFormat, setDatFormat] = useState<DatFormat>("surfaces");
  const [libraryTab, setLibraryTab] = useState(AIRFOIL_LIBRARY[0].key);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const designation = useMemo(() => {
    if (family === "naca5") {
      return `${n5L}${n5P}0${String(n5Thickness).padStart(2, "0")}`;
    }
    // naca4 (and the disabled naca6 tab falls back to a 4-digit designation
    // so nothing downstream ever sees an invalid/empty string).
    const p = n4Camber === 0 ? 0 : n4CamberPos;
    return `${n4Camber}${p}${String(n4Thickness).padStart(2, "0")}`;
  }, [family, n4Camber, n4CamberPos, n4Thickness, n5L, n5P, n5Thickness]);

  // Editable mirror of `designation` -- see the effect below for how typing
  // here and moving a slider stay in sync without fighting each other.
  const [designationInput, setDesignationInput] = useState(designation);
  const [designationError, setDesignationError] = useState<string | null>(null);

  useEffect(() => {
    setDesignationInput(designation);
    setDesignationError(null);
  }, [designation]);

  function handleDesignationChange(raw: string) {
    const digitsOnly = raw.replace(/[^0-9]/g, "").slice(0, 5);
    setDesignationInput(digitsOnly);
    if (digitsOnly.length !== 4 && digitsOnly.length !== 5) {
      setDesignationError(digitsOnly.length === 0 ? null : "Enter 4 or 5 digits");
      return;
    }
    const parsed = parseNacaDesignation(digitsOnly);
    if (!parsed) {
      setDesignationError("Not a valid NACA 4/5-digit code");
      return;
    }
    setDesignationError(null);
    if (parsed.family === "naca4") {
      setFamily("naca4");
      setN4Camber(parsed.camber);
      setN4CamberPos(Math.max(1, parsed.camberPos));
      setN4Thickness(parsed.thickness);
    } else {
      setFamily("naca5");
      setN5L(parsed.l);
      setN5P(parsed.p);
      setN5Thickness(parsed.thickness);
    }
  }

  function loadPreset(entry: LibraryEntry) {
    if (entry.airfoil.kind === "naca4") {
      setFamily("naca4");
      setN4Camber(Math.round(entry.airfoil.params.camber * 100));
      setN4CamberPos(Math.max(1, Math.round(entry.airfoil.params.camberPos * 10)));
      setN4Thickness(Math.round(entry.airfoil.params.thickness * 100));
    } else {
      setFamily("naca5");
      setN5L(Math.round(entry.airfoil.params.designCl / 0.15));
      setN5P(entry.airfoil.params.camberPosCode);
      setN5Thickness(Math.round(entry.airfoil.params.thickness * 100));
    }
  }

  const previewAirfoil: PreviewAirfoil = useMemo(() => {
    if (family === "naca5") {
      return {
        kind: "naca5",
        params: { designCl: 0.15 * n5L, camberPosCode: n5P as 1 | 2 | 3 | 4 | 5, thickness: n5Thickness / 100 },
      };
    }
    const p = n4Camber === 0 ? 0 : n4CamberPos / 10;
    return { kind: "naca4", params: { camber: n4Camber / 100, camberPos: p, thickness: n4Thickness / 100 } };
  }, [family, n4Camber, n4CamberPos, n4Thickness, n5L, n5P, n5Thickness]);

  const wingPreviewParams = useMemo(
    () => ({ airfoil: previewAirfoil, spanM, rootChordM, tipChordM, sweepDeg, dihedralDeg, washoutDeg }),
    [previewAirfoil, spanM, rootChordM, tipChordM, sweepDeg, dihedralDeg, washoutDeg],
  );

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      await engine.generateWing({
        naca: designation,
        span_m: spanM,
        root_chord_m: rootChordM,
        tip_chord_m: tipChordM,
        sweep_deg: sweepDeg,
        dihedral_deg: dihedralDeg,
        washout_deg: washoutDeg,
        n_chord_stations: 18,
        n_span_stations: 14,
      });
      navigate("/tool");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  function handleExportDat() {
    downloadTextFile(`naca-${designation}.dat`, buildDat(designation, previewAirfoil, datFormat));
  }
  function handleExportCsv() {
    downloadTextFile(`naca-${designation}.csv`, buildCsv(designation, previewAirfoil), "text/csv");
  }
  function handleExportSvg() {
    downloadTextFile(`naca-${designation}.svg`, buildSvg(designation, previewAirfoil), "image/svg+xml");
  }
  function handleExportPng() {
    void exportPng(designation, previewAirfoil, "#6fb3ff");
  }

  const activeCategory = AIRFOIL_LIBRARY.find((c) => c.key === libraryTab) ?? AIRFOIL_LIBRARY[0];

  return (
    <div className="bg-background min-h-screen">
      <SiteHeader />

      <section className="mx-auto max-w-7xl px-6 py-20">
        <div className="mb-10 flex flex-col gap-3">
          <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">Generator</span>
          <h1 className="text-4xl font-medium tracking-tight text-balance">Airfoil Generator</h1>
          <p className="text-muted-foreground max-w-2xl text-balance">
            Design a NACA section and extrude it into a full wing — sweep, taper, dihedral, and washout included.
            Generation happens server-side, from the exact same equations, and the result lands in the tool ready to
            fly.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_20rem]">
          <Card className="gap-4">
            <CardHeader>
              <CardTitle>Airfoil Section</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="bg-muted/60 flex gap-1 rounded-lg p-1">
                {FAMILIES.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    disabled={f.disabled}
                    onClick={() => setFamily(f.key)}
                    title={f.disabled ? "Needs published tabulated thickness data we don't have with confidence yet" : undefined}
                    className={cn(
                      "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-all",
                      f.disabled
                        ? "text-muted-foreground/40 cursor-not-allowed"
                        : family === f.key
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {f.label}
                    {f.disabled && <span className="ml-1 opacity-70">soon</span>}
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground font-data text-xs tracking-wide">NACA</span>
                  <input
                    value={designationInput}
                    onChange={(e) => handleDesignationChange(e.target.value)}
                    inputMode="numeric"
                    spellCheck={false}
                    placeholder="2412"
                    className={cn(
                      "font-data bg-muted text-foreground w-24 rounded-md border px-2.5 py-1 text-sm tracking-wide outline-none",
                      designationError ? "border-destructive" : "border-transparent focus:border-primary",
                    )}
                  />
                </div>
                <div className="bg-muted/60 flex gap-1 rounded-lg p-1">
                  <button
                    type="button"
                    onClick={() => setPreviewMode("2d")}
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium transition-all",
                      previewMode === "2d" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    2D
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewMode("3d")}
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium transition-all",
                      previewMode === "3d" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    3D
                  </button>
                </div>
              </div>
              {designationError && <p className="text-destructive -mt-2 text-xs">{designationError}</p>}

              <div className="border-border/70 relative overflow-hidden rounded-lg border">
                {previewMode === "2d" ? (
                  <>
                    <div
                      className="pointer-events-none absolute inset-0 opacity-[0.06]"
                      style={{
                        backgroundImage:
                          "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
                        backgroundSize: "16px 16px",
                      }}
                    />
                    <AirfoilPreview airfoil={previewAirfoil} />
                  </>
                ) : (
                  <>
                    <WingPreview3D params={wingPreviewParams} wireframe={renderMode === "wireframe"} />
                    <div className="bg-background/60 absolute right-2 bottom-2 flex gap-1 rounded-lg p-1 backdrop-blur-sm">
                      <button
                        type="button"
                        onClick={() => setRenderMode("wireframe")}
                        className={cn(
                          "rounded-md px-2 py-1 text-[0.65rem] font-medium tracking-wide uppercase transition-all",
                          renderMode === "wireframe" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        Wireframe
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenderMode("solid")}
                        className={cn(
                          "rounded-md px-2 py-1 text-[0.65rem] font-medium tracking-wide uppercase transition-all",
                          renderMode === "solid" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        Solid
                      </button>
                    </div>
                  </>
                )}
              </div>

              <Separator />

              {family === "naca4" ? (
                <>
                  <Row label="Max camber" value={String(n4Camber)} unit="% chord">
                    <Slider value={[n4Camber]} min={0} max={9} step={1} onValueChange={([v]) => setN4Camber(v)} />
                  </Row>
                  <Row label="Camber position" value={n4Camber === 0 ? "—" : `${n4CamberPos * 10}%`}>
                    <Slider
                      value={[n4CamberPos]}
                      min={1}
                      max={9}
                      step={1}
                      disabled={n4Camber === 0}
                      onValueChange={([v]) => setN4CamberPos(v)}
                    />
                  </Row>
                  <Row label="Max thickness" value={String(n4Thickness)} unit="% chord">
                    <Slider value={[n4Thickness]} min={4} max={24} step={1} onValueChange={([v]) => setN4Thickness(v)} />
                  </Row>
                </>
              ) : (
                <>
                  <Row label="Design lift coefficient" value={(0.15 * n5L).toFixed(2)}>
                    <Slider value={[n5L]} min={0} max={9} step={1} onValueChange={([v]) => setN5L(v)} />
                  </Row>
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs font-normal">Camber position</Label>
                    <Select value={String(n5P)} onValueChange={(v) => setN5P(Number(v))}>
                      <SelectTrigger size="sm" className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 4, 5].map((code) => (
                          <SelectItem key={code} value={String(code)}>
                            {CAMBER_POS_LABELS[code]} chord
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Row label="Max thickness" value={String(n5Thickness)} unit="% chord">
                    <Slider value={[n5Thickness]} min={4} max={24} step={1} onValueChange={([v]) => setN5Thickness(v)} />
                  </Row>
                  <p className="text-muted-foreground text-xs">
                    Reflexed camber lines (Q=1, e.g. 23112) aren't supported yet — every 5-digit section generated here
                    uses the standard, non-reflexed camber line.
                  </p>
                </>
              )}

              <Separator />

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
                    <Download className="size-3.5" /> Export section
                  </span>
                  <Select value={datFormat} onValueChange={(v) => setDatFormat(v as DatFormat)}>
                    <SelectTrigger size="sm" className="w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAT_FORMATS.map((f) => (
                        <SelectItem key={f} value={f}>
                          {DAT_FORMAT_LABELS[f]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <Button variant="outline" size="sm" onClick={handleExportDat}>
                    DAT
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleExportCsv}>
                    CSV
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleExportSvg}>
                    SVG
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleExportPng}>
                    PNG
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="gap-4">
            <CardHeader>
              <CardTitle>Wing Planform</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Row label="Span" value={spanM.toFixed(2)} unit="m">
                <Slider value={[spanM]} min={0.3} max={3} step={0.02} onValueChange={([v]) => setSpanM(v)} />
              </Row>
              <Row label="Root chord" value={rootChordM.toFixed(2)} unit="m">
                <Slider value={[rootChordM]} min={0.05} max={0.8} step={0.01} onValueChange={([v]) => setRootChordM(v)} />
              </Row>
              <Row label="Tip chord" value={tipChordM.toFixed(2)} unit="m">
                <Slider value={[tipChordM]} min={0.03} max={0.8} step={0.01} onValueChange={([v]) => setTipChordM(v)} />
              </Row>
              <Row label="Sweep" value={sweepDeg.toFixed(0)} unit="°">
                <Slider value={[sweepDeg]} min={-10} max={45} step={1} onValueChange={([v]) => setSweepDeg(v)} />
              </Row>
              <Row label="Dihedral" value={dihedralDeg.toFixed(0)} unit="°">
                <Slider value={[dihedralDeg]} min={-5} max={15} step={0.5} onValueChange={([v]) => setDihedralDeg(v)} />
              </Row>
              <Row label="Washout (tip twist)" value={washoutDeg.toFixed(1)} unit="°">
                <Slider value={[washoutDeg]} min={-10} max={5} step={0.5} onValueChange={([v]) => setWashoutDeg(v)} />
              </Row>

              <Separator />

              {error && <p className="text-destructive text-xs">{error}</p>}

              <Button size="lg" disabled={busy} onClick={generate} className="w-full">
                {busy ? (
                  <>
                    <LoaderCircle className="animate-spin" /> Generating…
                  </>
                ) : (
                  <>
                    <Sparkles /> Generate &amp; Open in Tool
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          <Card className="gap-4 xl:col-span-1 lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <SquareStack className="size-4" /> Airfoil Library
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="bg-muted/60 flex gap-1 rounded-lg p-1">
                {AIRFOIL_LIBRARY.map((cat) => (
                  <button
                    key={cat.key}
                    type="button"
                    onClick={() => setLibraryTab(cat.key)}
                    className={cn(
                      "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-all",
                      libraryTab === cat.key
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
              <p className="text-muted-foreground text-xs">{activeCategory.heading}</p>

              <div className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto pr-1">
                {activeCategory.entries.map((entry) => (
                  <div key={`${activeCategory.key}-${entry.designation}-${entry.name}`} className="border-border/60 flex items-center gap-3 rounded-lg border p-2">
                    <div className="border-border/50 h-10 w-16 shrink-0 overflow-hidden rounded-md border">
                      <AirfoilPreview airfoil={entry.airfoil} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-data text-foreground text-xs">NACA {entry.designation}</div>
                      <div className="text-muted-foreground truncate text-[0.7rem]">{entry.name}</div>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => loadPreset(entry)}>
                      Load
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
