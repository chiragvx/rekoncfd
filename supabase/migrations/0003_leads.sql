-- Rekon: a queryable, exportable record of who has signed up -- for lead
-- collection/outreach, not application logic. Run this against the same
-- Supabase project as the earlier migrations (SQL editor, or `supabase db
-- push`).
--
-- Why this exists rather than just using `auth.users` directly: Supabase
-- deliberately keeps `auth.*` out of the public Data API (PostgREST) and out
-- of any client-side access, so it's invisible to CRM/Zapier/BI tools and
-- awkward to browse -- you'd need the SQL editor or the Auth admin screen
-- every time. This is a `public`-schema mirror, kept in sync by triggers, so
-- it shows up in the ordinary Table Editor and is exportable to CSV like any
-- other table. Never contains a password or password hash -- those live only
-- in `auth.users`, which this table doesn't reference for that column at all.

create table if not exists public.leads (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  -- Populated from OAuth provider metadata when available (GitHub sign-in
  -- sets these; email/password sign-up leaves them null) -- never asked for
  -- directly, so treat both as "may be missing."
  full_name text,
  avatar_url text,
  -- "email" or "github" -- whichever `signInWithEmail`/`signUpWithEmail`/
  -- `signInWithGithub` (see web/src/lib/auth.tsx) the person used.
  provider text,
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz
);

-- Locked down on purpose: no insert/select/update/delete policy is defined
-- for the anon/authenticated roles, so RLS denies the browser entirely in
-- both directions. This table is only ever written by the trigger functions
-- below (which run as their `security definer` owner, not as a request
-- role) and only ever read via the Supabase dashboard or the service-role
-- key -- e.g. an export for an email/CRM tool.
alter table public.leads enable row level security;

-- Fires once, right after Supabase creates the `auth.users` row for a new
-- sign-up (email/password OR the first OAuth sign-in) -- captures the lead
-- the moment it exists, without any app-code change to the existing sign-up
-- flow. `security definer` is required: the trigger runs in a context that
-- must be allowed to write to `public.leads` regardless of who triggered it.
create or replace function public.handle_new_user_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.leads (id, email, full_name, avatar_url, provider, created_at, last_sign_in_at)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url',
    coalesce(new.raw_app_meta_data ->> 'provider', 'email'),
    new.created_at,
    new.last_sign_in_at
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_lead on auth.users;
create trigger on_auth_user_created_lead
  after insert on auth.users
  for each row
  execute function public.handle_new_user_lead();

-- Keeps `last_sign_in_at` current on every later login (Supabase updates
-- that column on `auth.users` itself each time) -- only fires when it
-- actually changed, so an unrelated update to the auth row (e.g. Supabase
-- refreshing something internal) doesn't do a needless write.
create or replace function public.handle_user_login_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.last_sign_in_at is distinct from old.last_sign_in_at then
    update public.leads
    set last_sign_in_at = new.last_sign_in_at
    where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_login_lead on auth.users;
create trigger on_auth_user_login_lead
  after update on auth.users
  for each row
  execute function public.handle_user_login_lead();

-- Backfills anyone who already signed up before this migration ran, so the
-- table starts complete rather than only capturing sign-ups from this point
-- forward.
insert into public.leads (id, email, full_name, avatar_url, provider, created_at, last_sign_in_at)
select
  id,
  email,
  raw_user_meta_data ->> 'full_name',
  raw_user_meta_data ->> 'avatar_url',
  coalesce(raw_app_meta_data ->> 'provider', 'email'),
  created_at,
  last_sign_in_at
from auth.users
on conflict (id) do nothing;
