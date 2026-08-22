import { useRef, useState, type DragEvent } from "react";
import { TriangleAlert, Upload, X } from "lucide-react";

import { engine, useEngineEvent, type ImportSummary } from "@/lib/engine";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ImportPanel({ onMeshSummaryChange }: { onMeshSummaryChange: (summary: ImportSummary | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  useEngineEvent("meshCleared", () => {
    setSummary(null);
    setBusy(null);
    setError(null);
    onMeshSummaryChange(null);
  });

  async function handleFile(file: File) {
    setBusy(file.name);
    setError(null);
    try {
      const result = await engine.importFile(file);
      setSummary(result);
      onMeshSummaryChange(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
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
                <span>Unit "{summary.unit}" is a low-confidence guess — dimensions below may be off.</span>
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
