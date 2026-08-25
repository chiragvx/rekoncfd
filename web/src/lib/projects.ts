import { supabase } from "@/lib/supabase";
import type { AxisMappingSummary, GenerateWingParams, SliderValues, VizState } from "@/lib/engine";

const BUCKET = "project-meshes";

export type ProjectSourceKind = "sample" | "generated" | "uploaded";

/** The axis mapping AND unit actually applied at import -- both are needed
 * to call `engine.orientMesh` again on reload, so both live together in the
 * `applied_mapping` jsonb column (only meaningful for `source_kind ===
 * "uploaded"`; sample/generated meshes are already in the app's own frame). */
export interface AppliedOrientation {
  mapping: AxisMappingSummary;
  unit: string;
}

/** Mirrors `supabase/migrations/0001_projects.sql`'s `projects` table. */
export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  source_kind: ProjectSourceKind;
  sample_id: string | null;
  generator_params: GenerateWingParams | null;
  storage_path: string | null;
  applied_mapping: AppliedOrientation | null;
  flight_condition: SliderValues;
  viz_state: VizState;
  created_at: string;
  updated_at: string;
}

export type ProjectSource =
  | { kind: "sample"; sampleId: string }
  | { kind: "generated"; params: GenerateWingParams }
  | { kind: "uploaded"; file: File };

export interface SaveProjectInput {
  name: string;
  source: ProjectSource;
  appliedOrientation: AppliedOrientation | null;
  flightCondition: SliderValues;
  vizState: VizState;
}

function requireSupabase() {
  if (!supabase) {
    throw new Error("Supabase is not configured -- set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  }
  return supabase;
}

export async function listProjects(): Promise<ProjectRow[]> {
  const client = requireSupabase();
  const { data, error } = await client.from("projects").select("*").order("updated_at", { ascending: false });
  if (error) throw error;
  return data as ProjectRow[];
}

/** Uploads the file first (for `source.kind === "uploaded"`) so the row
 * insert always has a valid `storage_path` -- never leaves a project row
 * pointing at a file that doesn't exist. If the row insert then fails, the
 * orphaned upload is deleted rather than left to leak storage quota. */
export async function saveProject(input: SaveProjectInput): Promise<ProjectRow> {
  const client = requireSupabase();
  const {
    data: { user },
    error: userError,
  } = await client.auth.getUser();
  if (userError || !user) throw new Error("Sign in before saving a project.");

  let storagePath: string | null = null;
  if (input.source.kind === "uploaded") {
    storagePath = `${user.id}/${crypto.randomUUID()}.stl`;
    const { error: uploadError } = await client.storage.from(BUCKET).upload(storagePath, input.source.file);
    if (uploadError) throw uploadError;
  }

  const { data, error } = await client
    .from("projects")
    .insert({
      user_id: user.id,
      name: input.name,
      source_kind: input.source.kind,
      sample_id: input.source.kind === "sample" ? input.source.sampleId : null,
      generator_params: input.source.kind === "generated" ? input.source.params : null,
      storage_path: storagePath,
      applied_mapping: input.appliedOrientation,
      flight_condition: input.flightCondition,
      viz_state: input.vizState,
    })
    .select()
    .single();

  if (error) {
    if (storagePath) await client.storage.from(BUCKET).remove([storagePath]);
    throw error;
  }
  return data as ProjectRow;
}

export async function deleteProject(project: ProjectRow): Promise<void> {
  const client = requireSupabase();
  if (project.storage_path) {
    await client.storage.from(BUCKET).remove([project.storage_path]);
  }
  const { error } = await client.from("projects").delete().eq("id", project.id);
  if (error) throw error;
}

/** Deletes every saved project (row + any stored STL) for the current user
 * -- the self-serve "erase my data" action surfaced from `AccountControl`.
 * Row Level Security already scopes `listProjects`/`deleteProject` to the
 * signed-in user, so this is just those two calls in sequence; no new
 * policy or server-side function is needed. This does NOT delete the
 * `auth.users` row itself (the email/login record) -- the client SDK has no
 * permission to do that, it requires the service-role key. A visitor who
 * wants that too should be pointed at the account-deletion contact route
 * described in the Privacy Policy. */
export async function deleteAllProjects(): Promise<void> {
  const projects = await listProjects();
  for (const project of projects) {
    await deleteProject(project);
  }
}

/** Downloads an uploaded project's stored STL back into a real `File`, ready
 * to hand to `engine.importFile` -- the same path a fresh drag-and-drop
 * import already goes through, so re-loading a saved project reuses that
 * exact code rather than a second import pathway. Only valid for
 * `source_kind === "uploaded"` rows. */
export async function downloadProjectFile(project: ProjectRow): Promise<File> {
  const client = requireSupabase();
  if (!project.storage_path) throw new Error("This project has no stored file to download.");
  const { data, error } = await client.storage.from(BUCKET).download(project.storage_path);
  if (error) throw error;
  return new File([data], `${project.name}.stl`, { type: "application/octet-stream" });
}
