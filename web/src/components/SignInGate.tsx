import { useState } from "react";

import { signInWithEmail, signInWithGithub, signUpWithEmail } from "@/lib/auth";
import { RekonMark } from "@/components/RekonMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

/** Full-page sign-in gate shown instead of the Tool's own UI until the user
 * is authenticated -- blocks BOTH the hosted web build and the desktop .exe
 * equally, since they run the exact same React route. Only actually enforced
 * when Supabase is configured at all (see `ToolPage`) -- a deployment with
 * no Supabase project connected falls back to open access rather than
 * locking everyone out with no way to ever sign in. */
export function SignInGate() {
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
    <div className="bg-background fixed inset-0 flex items-center justify-center p-4">
      <div className="border-border bg-card surface-elevated w-full max-w-sm rounded-2xl border p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <RekonMark className="text-primary size-9" />
          <h1 className="text-lg font-medium tracking-tight">Sign in to Rekon</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            The tool is only available to signed-in users -- create an account or continue with GitHub.
          </p>
        </div>

        {confirmSent ? (
          <p className="text-muted-foreground mt-6 text-center text-sm leading-relaxed">
            Check <span className="text-foreground">{email}</span> for a confirmation link, then sign in below.
          </p>
        ) : (
          <>
            <Button variant="outline" className="mt-6 w-full" disabled={busy} onClick={handleGithub}>
              Continue with GitHub
            </Button>

            <div className="my-4 flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-muted-foreground text-xs">or</span>
              <Separator className="flex-1" />
            </div>

            <form onSubmit={handleEmailSubmit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="gate-email" className="text-xs font-normal">
                  Email
                </Label>
                <Input
                  id="gate-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="gate-password" className="text-xs font-normal">
                  Password
                </Label>
                <Input
                  id="gate-password"
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
              className="text-muted-foreground hover:text-foreground mt-4 w-full text-center text-xs transition-colors"
            >
              {mode === "sign-in" ? "Need an account? Sign up" : "Already have an account? Sign in"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
