-- Rekon: launch/updates email capture. Run this against the same Supabase
-- project as 0001_projects.sql (SQL editor, or `supabase db push`).
--
-- Distinct from `auth.users` on purpose: this is for visitors who want
-- product-update emails WITHOUT creating an account. No password, no
-- session, just an email address -- so it gets its own table rather than
-- being folded into auth.

create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  -- Free-form, set by the caller (e.g. "footer", "download-prompt") --
  -- purely descriptive, never branched on server-side.
  source text,
  created_at timestamptz not null default now()
);

alter table public.subscribers enable row level security;

-- Anyone (including an unauthenticated visitor) may add their own email --
-- this is a public marketing signup form, not user data.
create policy "Anyone can subscribe"
  on public.subscribers for insert
  with check (true);

-- No select/update/delete policy is defined for the anon/authenticated
-- roles, which means RLS denies all of them by default -- the list is only
-- ever readable via the Supabase dashboard or the service-role key (e.g. an
-- export for an email tool), never from the browser. A visitor re-submitting
-- the same email hits the `unique` constraint rather than exposing whether
-- that address is already subscribed (the client should treat that specific
-- error as a success, not surface it as one).
