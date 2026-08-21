import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { LoaderCircle, Sparkles } from "lucide-react";

import { engine } from "@/lib/engine";
import type { PreviewAirfoil } from "@/lib/airfoilPreview";
import { SiteHeader } from "@/components/SiteHeader";
import { AirfoilPreview } from "@/components/AirfoilPreview";
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

  return (
    <div className="bg-background min-h-screen">
      <SiteHeader />

      <section className="mx-auto max-w-5xl px-6 py-20">
        <div className="mb-10 flex flex-col gap-3">
          <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">Generator</span>
          <h1 className="text-4xl font-medium tracking-tight text-balance">Airfoil Generator</h1>
          <p className="text-muted-foreground max-w-2xl text-balance">
            Design a NACA section and extrude it into a full wing — sweep, taper, dihedral, and washout included.
            Generation happens server-side, from the exact same equations, and the result lands in the tool ready to
            fly.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
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
                    title={f.disabled ? "6-series thickness/camber tables aren't integrated yet" : undefined}
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

              <div className="border-border/70 relative overflow-hidden rounded-lg border">
                <div
                  className="pointer-events-none absolute inset-0 opacity-[0.06]"
                  style={{
                    backgroundImage:
                      "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
                    backgroundSize: "16px 16px",
                  }}
                />
                <AirfoilPreview airfoil={previewAirfoil} />
              </div>
              <div className="-mt-2 flex justify-center">
                <span className="font-data bg-muted text-foreground rounded-md px-2.5 py-1 text-xs tracking-wide">
                  NACA {designation}
                </span>
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
        </div>
      </section>
    </div>
  );
}
