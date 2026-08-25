import { useState, type FormEvent } from "react";
import { Check } from "lucide-react";

import { isSupabaseConfigured } from "@/lib/supabase";
import { subscribe } from "@/lib/subscribe";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Footer email-updates signup -- gated on Supabase being configured, same
 * as `AccountControl`, since there's nowhere to send the address otherwise. */
export function NewsletterForm({ source }: { source: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isSupabaseConfigured) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await subscribe(email, source);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't subscribe. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p className="text-success flex items-center gap-1.5 text-sm">
        <Check className="size-4" /> You're on the list.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <span className="text-muted-foreground font-data text-[11px] tracking-[0.15em] uppercase">Get updates</span>
      <div className="flex items-center gap-2">
        <Input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-8 w-44 text-xs"
          aria-label="Email for product updates"
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy}>
          {busy ? "…" : "Subscribe"}
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </form>
  );
}
