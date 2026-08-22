import { useRef, useState, type DragEvent } from "react";
import { TriangleAlert, Upload, X } from "lucide-react";

import { engine, useEngineEvent, type AxisMappingSummary, type ImportSummary } from "@/lib/engine";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

const AXIS_OPTIONS = ["+x", "-x", "+y", "-y", "+z", "-z"];
const UNIT_OPTIONS = [
  { value: "mm", label: "mm" },
  { value: "cm", label: "cm" },
  { value: "m", label: "m" },
  { value: "in", label: "in" },
];

function distinctAxes(chord: string, up: string, span: string): boolean {
  const bases = [chord, up, span].map((a) => a.slice(1));
  return new Set(bases).size === 3;
}

export function ImportPanel({ onMeshSummaryChange }: { onMeshSummaryChange: (summary: ImportSummary | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inferredRef = useRef<{ mapping: AxisMappingSummary; unit: string } | null>(null);

  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [orientError, setOrientError] = useState<string | null>(null);
  const [chordAxis, setChordAxis] = useState("+x");
  const [upAxis, setUpAxis] = useState("+y");
  const [spanAxis, setSpanAxis] = useState("+z");
  const [unit, setUnit] = useState("mm");

  useEngineEvent("meshCleared", () => {
    setSummary(null);
    setBusy(null);
    setError(null);
    inferredRef.current = null;
    onMeshSummaryChange(null);
  });

  async function handleFile(file: File) {
    setBusy(file.name);
    setError(null);
    try {
      const result = await engine.importFile(file);
      inferredRef.current = { mapping: result.mapping, unit: result.unit };
      applySummary(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function applySummary(result: ImportSummary) {
    setSummary(result);
    setChordAxis(result.mapping.chord);
    setUpAxis(result.mapping.up);
    setSpanAxis(result.mapping.span);
    setUnit(result.unit);
    setOrientError(null);
    onMeshSummaryChange(result);
  }

  async function applyOrientation(chord: string, up: string, span: string, u: string) {
    if (!distinctAxes(chord, up, span)) {
      setOrientError("Chord, up, and span must be 3 distinct axes (ignoring sign).");
      return;
    }
    setOrientError(null);
    try {
      const result = await engine.orientMesh({ chord, up, span }, u);
      applySummary(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  async function handleClear() {
    try {
      await engine.clearMesh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function resetToAuto() {
    const inferred = inferredRef.current;
    if (!inferred) return;
    setChordAxis(inferred.mapping.chord);
    setUpAxis(inferred.mapping.up);
    setSpanAxis(inferred.mapping.span);
    setUnit(inferred.unit);
    void applyOrientation(inferred.mapping.chord, inferred.mapping.up, inferred.mapping.span, inferred.unit);
  }

  return (
    <Card id="coach-import" className="w-full gap-3">
      <CardHeader>
        <CardTitle>Import</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label
          className="border-border hover:border-primary/50 hover:bg-accent/30 data-[dragging=true]:border-primary data-[dragging=true]:bg-accent/40 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed py-5 text-center transition-colors"
          data-dragging={dragging}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".stl"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = "";
            }}
          />
          <Upload className="text-muted-foreground size-5" />
          <span className="text-muted-foreground text-xs">
            {busy ? `Importing ${busy}…` : "Drop STL or click to import"}
          </span>
        </label>

        {error && <p className="text-destructive text-xs">{error}</p>}

        {summary && (
          <>
            <div className="font-data text-muted-foreground flex flex-col gap-0.5 text-xs">
              <span>
                {summary.vertex_count.toLocaleString()} verts / {summary.triangle_count.toLocaleString()} tris /{" "}
                {summary.panel_count.toLocaleString()} panels
              </span>
              <span>
                span {summary.span_m.toFixed(3)}m &nbsp;chord~{summary.chord_estimate_m.toFixed(3)}m &nbsp;thickness~
                {summary.thickness_estimate_m.toFixed(4)}m
              </span>
              <span>voxel occupancy {(summary.voxel_occupancy * 100).toFixed(2)}%</span>
            </div>

            {!summary.unit_confident && (
              <div className="flex items-start gap-1.5 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>Unit "{summary.unit}" is a low-confidence guess — verify below.</span>
              </div>
            )}
            {summary.warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-1.5 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{w}</span>
              </div>
            ))}

            <Button variant="destructive" size="sm" onClick={handleClear} className="w-full">
              <X /> Clear Import
            </Button>

            <Separator />

            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium">Orientation</span>

              <OrientRow
                label="Flow / chord X"
                value={chordAxis}
                onChange={(v) => {
                  setChordAxis(v);
                  void applyOrientation(v, upAxis, spanAxis, unit);
                }}
              />
              <OrientRow
                label="Up Y"
                value={upAxis}
                onChange={(v) => {
                  setUpAxis(v);
                  void applyOrientation(chordAxis, v, spanAxis, unit);
                }}
              />
              <OrientRow
                label="Span Z"
                value={spanAxis}
                onChange={(v) => {
                  setSpanAxis(v);
                  void applyOrientation(chordAxis, upAxis, v, unit);
                }}
              />

              <div className="flex items-center justify-between gap-2">
                <Label className="text-muted-foreground text-xs font-normal">Unit</Label>
                <Select
                  value={unit}
                  onValueChange={(v) => {
                    setUnit(v);
                    void applyOrientation(chordAxis, upAxis, spanAxis, v);
                  }}
                >
                  <SelectTrigger size="sm" className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UNIT_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {orientError && <p className="text-destructive text-xs">{orientError}</p>}

              <Button variant="secondary" size="sm" onClick={resetToAuto} className="w-full">
                Reset to auto
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function OrientRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-muted-foreground text-xs font-normal">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="w-24">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AXIS_OPTIONS.map((a) => (
            <SelectItem key={a} value={a}>
              {a}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
