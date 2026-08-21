import { useEffect, useState } from "react";
import { LoaderCircle, Sparkles, X } from "lucide-react";

import { engine } from "@/lib/engine";
import { Button } from "@/components/ui/button";

type Phase = "idle" | "available" | "updating" | "done" | "error";

/** Only ever fires anything when running the desktop build's local server
 * -- a hosted web deployment has no update path of its own (it's just
 * redeployed whenever we ship), and `/api/version` there would report
 * `update_available: false` regardless. Checks once on mount; deliberately
 * NOT a polling loop -- a session is short enough that a single check at
 * launch is what actually matters, and repeated background polling would
 * just be background network noise for no real benefit. */
export function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [latest, setLatest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    engine
      .getVersionInfo()
      .then((info) => {
        if (info.update_available && info.latest) {
          setLatest(info.latest);
          setPhase("available");
        }
      })
      .catch(() => {
        /* No release reachable yet -- stay silent, this is expected pre-launch. */
      });
  }, []);

  async function update() {
    setPhase("updating");
    setError(null);
    try {
      const result = await engine.applyUpdate();
      setLatest(result.version);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  if (dismissed || phase === "idle") return null;

  return (
    <div className="border-border/60 bg-card fixed top-14 inset-x-0 z-30 flex items-center justify-center gap-3 border-b px-4 py-2 shadow-md">
      {phase === "available" && (
        <>
          <Sparkles className="text-primary size-4" />
          <span className="text-sm">
            Update available — <span className="font-data">v{latest}</span>
          </span>
          <Button size="sm" onClick={update}>
            Update &amp; Restart
          </Button>
          <button
            aria-label="Dismiss"
            onClick={() => setDismissed(true)}
            className="text-muted-foreground hover:text-foreground ml-1"
          >
            <X className="size-4" />
          </button>
        </>
      )}
      {phase === "updating" && (
        <span className="text-muted-foreground flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin" /> Downloading and installing v{latest}…
        </span>
      )}
      {phase === "done" && (
        <span className="text-success text-sm">
          Updated to <span className="font-data">v{latest}</span> — close and reopen Rekon to finish.
        </span>
      )}
      {phase === "error" && <span className="text-destructive text-sm">Update failed: {error}</span>}
    </div>
  );
}
