import { useState } from "react";
import { X } from "lucide-react";

import { signInWithEmail, signInWithGithub, signUpWithEmail } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

/** GitHub OAuth + email/password sign-in, gated entirely on a Supabase
 * project actually being connected -- `AccountControl` never renders the
 * trigger that opens this until `isSupabaseConfigured` is true, so this
 * component itself doesn't need its own "not configured" state. */
export function AuthModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);

  async function handleGithub() {
    setBusy(true);
    setError(null);
    try {
      await signInWithGithub();
      // Redirects the whole page to GitHub -- no further local state change.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "sign-in") {
        await signInWithEmail(email, password);
        onClose();
      } else {
        await signUpWithEmail(email, password);
        setConfirmSent(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="border-border bg-card surface-elevated relative w-full max-w-sm rounded-2xl border p-6">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-muted-foreground hover:text-foreground absolute top-3 right-3 rounded-md p-1.5 transition-colors"
        >
          <X className="size-4" />
        </button>

        <h2 className="text-lg font-medium tracking-tight">Sign in to Rekon</h2>
        <p className="text-muted-foreground mt-1 text-sm">Save projects and pick up where you left off.</p>

        {confirmSent ? (
          <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
            Check <span className="text-foreground">{email}</span> for a confirmation link, then sign in.
          </p>
        ) : (
          <>
            <Button variant="outline" className="mt-5 w-full" disabled={busy} onClick={handleGithub}>
              Continue with GitHub
            </Button>

            <div className="my-4 flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-muted-foreground text-xs">or</span>
              <Separator className="flex-1" />
            </div>

            <form onSubmit={handleEmailSubmit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="auth-email" className="text-xs font-normal">
                  Email
                </Label>
                <Input
                  id="auth-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="auth-password" className="text-xs font-normal">
                  Password
                </Label>
                <Input
                  id="auth-password"
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                />
              </div>

              {error && <p className="text-destructive text-xs">{error}</p>}

              <Button type="submit" disabled={busy} className="mt-1 w-full">
                {mode === "sign-in" ? "Sign in" : "Create account"}
              </Button>
            </form>

            <button
              type="button"
              onClick={() => {
                setMode((m) => (m === "sign-in" ? "sign-up" : "sign-in"));
                setError(null);
              }}
              className="text-muted-foreground hover:text-foreground mt-4 text-xs transition-colors"
            >
              {mode === "sign-in" ? "Need an account? Sign up" : "Already have an account? Sign in"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
