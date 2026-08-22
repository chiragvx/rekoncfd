-- Rekon: saved-project storage. Run this against a Supabase project via the
-- SQL editor (or `supabase db push` if you're using the CLI locally) once
-- you've connected your own project -- it's a no-op with no external
-- dependencies of its own, just Postgres + the auth schema Supabase already
-- provisions.
--
-- Design: a project's geometry is stored as PARAMETERS whenever possible
-- (sample_id for an Explore Models entry, generator_params for an Airfoil
-- Generator wing) -- tiny, exact, and reproducible by re-running the same
-- request the app already makes. Only a user-UPLOADED STL has no such
-- parametric source, so that case alone stores an actual file, in Supabase
-- Storage rather than the row itself.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Untitled project',

  -- Exactly one of sample_id / generator_params / storage_path is set,
  -- matching source_kind -- enforced by the check constraint below rather
  -- than split across three tables, since a project is read/written as one
  -- unit and the branching is small.
  source_kind text not null check (source_kind in ('sample', 'generated', 'uploaded')),
  sample_id text,
  generator_params jsonb,
  storage_path text,

  -- The axis mapping + unit actually applied at import (only meaningful for
  -- 'uploaded' -- sample/generated meshes are already in the app's own
  -- frame). Persisted so re-loading an uploaded project doesn't fall back to
  -- guessed orientation if the user had corrected it.
  applied_mapping jsonb,

  -- SliderValues-shaped: { alphaDeg, vInf, cg: {x,y,z}, bankDeg }.
  flight_condition jsonb not null default '{}'::jsonb,
  -- VizState-shaped (see web/src/lib/engine.ts).
  viz_state jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint projects_source_matches_kind check (
    (source_kind = 'sample' and sample_id is not null and generator_params is null and storage_path is null)
    or (source_kind = 'generated' and generator_params is not null and sample_id is null and storage_path is null)
    or (source_kind = 'uploaded' and storage_path is not null and sample_id is null and generator_params is null)
  )
);

create index if not exists projects_user_id_updated_at_idx on public.projects (user_id, updated_at desc);

alter table public.projects enable row level security;

create policy "Users can view their own projects"
  on public.projects for select
  using (auth.uid() = user_id);

create policy "Users can insert their own projects"
  on public.projects for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own projects"
  on public.projects for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own projects"
  on public.projects for delete
  using (auth.uid() = user_id);

-- Keeps `updated_at` accurate on every edit (e.g. re-saving over an existing
-- project) without every call site having to remember to set it.
create or replace function public.set_projects_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row
  execute function public.set_projects_updated_at();

-- Storage bucket for uploaded-STL projects. Private (not publicly
-- readable) -- every read/write goes through the policies below, scoped to
-- files under the requesting user's own `{user_id}/...` prefix.
insert into storage.buckets (id, name, public)
values ('project-meshes', 'project-meshes', false)
on conflict (id) do nothing;

create policy "Users can read their own project files"
  on storage.objects for select
  using (bucket_id = 'project-meshes' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can upload their own project files"
  on storage.objects for insert
  with check (bucket_id = 'project-meshes' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can delete their own project files"
  on storage.objects for delete
  using (bucket_id = 'project-meshes' and (storage.foldername(name))[1] = auth.uid()::text);
