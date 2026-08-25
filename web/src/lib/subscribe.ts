import { supabase } from "@/lib/supabase";

/** Adds an email to `public.subscribers` (see
 * `supabase/migrations/0002_subscribers.sql`) -- no auth required, this is
 * a public marketing signup, not account creation. Re-submitting the same
 * address hits the table's `unique` constraint (Postgres error code 23505);
 * treated as success here rather than surfaced as an error, since from the
 * visitor's point of view "you're already subscribed" IS the outcome they
 * wanted. */
export async function subscribe(email: string, source: string): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.from("subscribers").insert({ email, source });
  if (error && error.code !== "23505") throw error;
}
