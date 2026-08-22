import { useEffect, useRef, useState } from "react";
import { FolderOpen, LoaderCircle, Save, Trash2, Upload } from "lucide-react";

import { engine, useEngineEvent } from "@/lib/engine";
import { useAuth } from "@/lib/auth";
import { deleteProject, downloadProjectFile, listProjects, saveProject, type ProjectRow } from "@/lib/projects";
import { AuthModal } from "@/components/AuthModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Save/Open as a compact pair of dropdowns in the top nav strip -- a
 * familiar "File > Save / Open" affordance instead of a permanently-visible
 * sidebar section buried at the bottom of the right panel, which needed
 * scrolling and expanding a collapsible group to even find. Only mounted
 * from `ToolNav` when `isSupabaseConfigured` (same gate `SaveProjectPanel`
 * used to have). Shares the exact same save/load/delete logic that panel
 * had -- this replaces it rather than duplicating a second implementation. */
export function ProjectMenu() {
  const { user } = useAuth();
  const [hasMesh, setHasMesh] = useState(false);
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<"save" | "open" | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Closes whichever dropdown is open on an outside click -- the standard
  // expectation for a menu like this, and without it the two dropdowns can
  // never be dismissed except by re-clicking their own trigger.
  useEffect(() => {
    if (!openMenu) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpenMenu(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openMenu]);

  function toggle(menu: "save" | "open") {
    setError(null);
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    if (menu === "open" && !projectsLoaded) void refreshProjects();
    setOpenMenu((current) => (current === menu ? null : menu));
  }

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
      setOpenMenu(null);
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
      setOpenMenu(null);
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
    <div ref={containerRef} className="relative flex items-center gap-1">
      <Button variant="ghost" size="sm" onClick={() => toggle("save")} className="gap-1.5">
        <Save className="size-4" /> Save
      </Button>
      <Button variant="ghost" size="sm" onClick={() => toggle("open")} className="gap-1.5">
        <FolderOpen className="size-4" /> Open
      </Button>

      {openMenu === "save" && (
        <div className="border-border bg-popover surface-elevated absolute top-full right-0 z-30 mt-2 w-64 rounded-lg border p-3">
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              placeholder="Project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!hasMesh || busyId === "saving"}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
            {!hasMesh && <p className="text-muted-foreground text-xs">Import or generate a wing first.</p>}
            {error && <p className="text-destructive text-xs">{error}</p>}
            <Button size="sm" disabled={!hasMesh || busyId === "saving"} onClick={handleSave} className="w-full">
              {busyId === "saving" ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
              Save project
            </Button>
          </div>
        </div>
      )}

      {openMenu === "open" && (
        <div className="border-border bg-popover surface-elevated absolute top-full right-0 z-30 mt-2 w-72 rounded-lg border p-3">
          {error && <p className="text-destructive mb-2 text-xs">{error}</p>}
          {projects.length === 0 ? (
            <p className="text-muted-foreground text-xs">No saved projects yet.</p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
              {projects.map((p) => (
                <li key={p.id} className="border-border/60 flex items-center justify-between gap-2 rounded-md border px-2.5 py-2">
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
        </div>
      )}

      {authModalOpen && <AuthModal onClose={() => setAuthModalOpen(false)} />}
    </div>
  );
}
