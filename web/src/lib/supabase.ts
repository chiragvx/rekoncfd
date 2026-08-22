import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Auth and project save/load are entirely optional features layered on top
 * of the core tool -- gate everything on this rather than letting a missing
 * env var surface as a runtime crash. `false` until a real Supabase project
 * is connected (see `.env.example`), at which point every consumer of this
 * flag (AccountControl, AuthModal, SaveProjectPanel) starts rendering for
 * real with no other code change needed. */
export const isSupabaseConfigured = Boolean(url && anonKey);

/** `null` when not configured -- every caller must check `isSupabaseConfigured`
 * (or just null-check this directly) before using it. Constructing the
 * client at all requires a well-formed URL, so this must stay conditional
 * rather than always calling `createClient` with possibly-empty strings. */
export const supabase: SupabaseClient | null = isSupabaseConfigured ? createClient(url, anonKey) : null;
