import { useEffect, useRef, useState } from "react";
import { Download, ShieldCheck, X } from "lucide-react";

import { engine, useEngineEvent } from "@/lib/engine";
import { downloadUrlFor, fetchLatestRelease } from "@/lib/release";
import { Button } from "@/components/ui/button";
import { WingRenderArt } from "@/components/WingRenderArt";

const WINDOWS_ASSET = "rekon-app-x86_64-pc-windows-msvc.exe";
const HAS_DOWNLOADED_KEY = "rekon:hasDownloadedApp";
/** How long to wait for the WS to reach "open" before concluding there's no
 * local server behind this page (i.e. this is the hosted web build, not the
 * downloaded desktop app) and showing the prompt. Generous enough to ride
 * out a slow local server launch or one bad reconnect attempt without a
 * false positive. */
const GRACE_PERIOD_MS = 3000;

/** Prompts a first-time visitor on the hosted web build to download the
 * desktop app, since this page has no backend of its own to actually solve
 * anything (see `RekonSocket`: it retries forever, so "closed" alone isn't
 * enough signal -- only a status that NEVER reaches "open" within a grace
 * period means there's truly no local server here). Never shows at all once
 * the user has actually clicked through to download -- that's the one
 * permanent suppression condition; a plain dismiss only hides it for the
 * current visit, since "still no connection" is still true and worth
 * mentioning again next time. */
export function DownloadPromptModal() {
  const [visible, setVisible] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const armedRef = useRef(false);

  function alreadyDownloaded() {
    try {
      return localStorage.getItem(HAS_DOWNLOADED_KEY) === "1";
    } catch {
      return false; // localStorage unavailable (private browsing, etc.) -- fail open, show the prompt
    }
  }

  function arm() {
    if (armedRef.current || alreadyDownloaded()) return;
    armedRef.current = true;
    timerRef.current = window.setTimeout(() => {
      if (engine.getWsStatus() !== "open" && !alreadyDownloaded()) setVisible(true);
    }, GRACE_PERIOD_MS);
  }

  function resolve() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  }

  useEffect(() => {
    if (engine.getWsStatus() === "open") return;
    arm();
    fetchLatestRelease()
      .then((r) => setVersion(r.version))
      .catch(() => {});
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEngineEvent("wsStatus", (status) => {
    if (status === "open") resolve();
  });

  function handleDownloadClick() {
    try {
      localStorage.setItem(HAS_DOWNLOADED_KEY, "1");
    } catch {
      /* private browsing or storage disabled -- nothing more we can do, and the download itself still proceeds */
    }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="border-border bg-card surface-elevated relative w-full max-w-md overflow-hidden rounded-2xl border">
        <button
          type="button"
          onClick={() => setVisible(false)}
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-foreground hover:bg-accent absolute top-3 right-3 z-10 rounded-md p-1.5 transition-colors"
        >
          <X className="size-4" />
        </button>

        <WingRenderArt />

        <div className="flex flex-col gap-4 px-6 pb-6 pt-1">
          <div className="flex flex-col gap-1.5">
            <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">No local solver connected</span>
            <h2 className="text-xl font-medium tracking-tight text-balance">This page can't actually fly your wing</h2>
            <p className="text-muted-foreground text-sm text-balance">
              Rekon's panel-method and lattice-Boltzmann solvers run entirely on your own machine — this hosted page
              has nothing behind it to compute against. Download the standalone app to get real CL/CD/Cm and a live
              flow field.
            </p>
          </div>

          <div className="border-border/60 bg-background/40 flex flex-col gap-2 rounded-lg border p-3">
            <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
              <ShieldCheck className="text-success size-4 shrink-0" />
              Why trust an unsigned .exe?
            </div>
            <ul className="text-muted-foreground flex flex-col gap-1 pl-6 text-xs leading-relaxed">
              <li className="list-disc">
                Fully{" "}
                <a
                  href="https://github.com/chiragvx/rekoncfd"
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline underline-offset-2"
                >
                  open source
                </a>{" "}
                — read or build the exact code yourself.
              </li>
              <li className="list-disc">Runs 100% offline, only on 127.0.0.1 — nothing you design ever leaves your machine.</li>
              <li className="list-disc">
                SmartScreen may warn because it isn't code-signed (a paid cert small open-source projects skip) — the
                release page publishes a SHA-256 checksum for every build if you want to verify it.
              </li>
            </ul>
          </div>

          <div className="flex items-center gap-2">
            <Button asChild size="lg" className="flex-1" onClick={handleDownloadClick}>
              <a href={downloadUrlFor(WINDOWS_ASSET)}>
                <Download /> Download for Windows{version ? ` (v${version})` : ""}
              </a>
            </Button>
            <Button variant="outline" size="lg" onClick={() => setVisible(false)}>
              Not now
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
