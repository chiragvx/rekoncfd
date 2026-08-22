import { useEffect, useState } from "react";
import { LoaderCircle, Save, Trash2, Upload } from "lucide-react";

import { engine, useEngineEvent } from "@/lib/engine";
import { isSupabaseConfigured } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { deleteProject, downloadProjectFile, listProjects, saveProject, type ProjectRow } from "@/lib/projects";
import { AuthModal } from "@/components/AuthModal";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/** Save/load projects to Supabase -- entirely hidden until a project is
 * connected (see `lib/supabase.ts`), so this is safe to mount unconditionally
 * from `ToolPage` well before that happens. Dispatches a load back through
 * whichever of the three existing mesh-loading paths (`loadSampleModel` /
 * `generateWing` / `importFile`) the saved project's `source_kind` matches,
 * rather than a separate load pathway of its own. */
export function SaveProjectPanel() {
  const { user } = useAuth();
  const [hasMesh, setHasMesh] = useState(false);
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  useEngineEvent("meshGeometry", () => setHasMesh(true));
  useEngineEvent("meshCleared", () => setHasMesh(false));

  async function refreshProjects() {
    try {
      setProjects(await listProjects());
      setProjectsLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (user && !projectsLoaded) void refreshProjects();
    if (!user) setProjectsLoaded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, projectsLoaded]);

  if (!isSupabaseConfigured) return null;

  async function handleSave() {
    const source = engine.getLastMeshSource();
    if (!source) {
      setError("Import or generate a wing before saving.");
      return;
    }
    setBusyId("saving");
    setError(null);
    try {
      const summary = engine.getLastImportSummary();
      await saveProject({
        name: name.trim() || "Untitled project",
        source,
        appliedOrientation: source.kind === "uploaded" && summary ? { mapping: summary.mapping, unit: summary.unit } : null,
        flightCondition: engine.getLastSliderValues(),
        vizState: engine.getVizState(),
      });
      setName("");
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleLoad(project: ProjectRow) {
    setBusyId(project.id);
    setError(null);
    try {
      if (project.source_kind === "sample" && project.sample_id) {
        await engine.loadSampleModel(project.sample_id);
      } else if (project.source_kind === "generated" && project.generator_params) {
        await engine.generateWing(project.generator_params);
      } else if (project.source_kind === "uploaded") {
        const file = await downloadProjectFile(project);
        await engine.importFile(file);
        if (project.applied_mapping) {
          await engine.orientMesh(project.applied_mapping.mapping, project.applied_mapping.unit);
        }
      }
      engine.sendSlider(project.flight_condition);
      engine.applyVizState(project.viz_state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(project: ProjectRow) {
    setBusyId(project.id);
    setError(null);
    try {
      await deleteProject(project);
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="w-full gap-3">
      <CardHeader>
        <CardTitle>Projects</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!user ? (
          <>
            <p className="text-muted-foreground text-sm leading-relaxed">Sign in to save and reload your projects.</p>
            <Button size="sm" variant="outline" className="w-fit" onClick={() => setAuthModalOpen(true)}>
              Sign in
            </Button>
            {authModalOpen && <AuthModal onClose={() => setAuthModalOpen(false)} />}
          </>
        ) : (
          <>
            <div className="flex gap-2">
              <Input
                placeholder="Project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!hasMesh || busyId === "saving"}
              />
              <Button size="sm" disabled={!hasMesh || busyId === "saving"} onClick={handleSave}>
                {busyId === "saving" ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                Save
              </Button>
            </div>
            {!hasMesh && <p className="text-muted-foreground text-xs">Import or generate a wing first.</p>}

            {error && <p className="text-destructive text-xs">{error}</p>}

            {projects.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {projects.map((p) => (
                  <li
                    key={p.id}
                    className="border-border/60 flex items-center justify-between gap-2 rounded-md border px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{p.name}</div>
                      <div className="text-muted-foreground font-data text-[10px]">
                        {new Date(p.updated_at).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      title="Load"
                      disabled={busyId !== null}
                      onClick={() => handleLoad(p)}
                      className="text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors disabled:opacity-40"
                    >
                      {busyId === p.id ? <LoaderCircle className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                    </button>
                    <button
                      type="button"
                      title="Delete"
                      disabled={busyId !== null}
                      onClick={() => handleDelete(p)}
                      className="text-muted-foreground hover:text-destructive rounded-md p-1.5 transition-colors disabled:opacity-40"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
