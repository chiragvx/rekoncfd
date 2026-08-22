import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";

import { supabase, isSupabaseConfigured } from "@/lib/supabase";

interface AuthState {
  user: User | null;
  /** True only during the initial session check -- never true again after,
   * even while a sign-in/sign-out is in flight, since `onAuthStateChange`
   * delivers those as a single atomic update rather than a pending state. */
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ user: null, loading: false });

/** Wrap the app (or just the Tool page) in this once. Everything else here
 * -- `useAuth`, the sign-in helpers -- is a no-op/no-session read when
 * Supabase isn't configured, so mounting this unconditionally is safe even
 * before a project is connected. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: isSupabaseConfigured });

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      setState({ user: data.session?.user ?? null, loading: false });
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ user: session?.user ?? null, loading: false });
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

/** Redirects to GitHub, then back into the app once Supabase's own OAuth
 * callback completes -- `/tool` specifically, since that's the one place
 * sign-in actually matters (see `SaveProjectPanel`). Must be in Supabase's
 * Auth redirect allow-list, along with the hosted domain, for this to work
 * from the desktop app's 127.0.0.1 origin too. */
export async function signInWithGithub(): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: `${window.location.origin}/tool` },
  });
  if (error) throw error;
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUpWithEmail(email: string, password: string): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut();
}
