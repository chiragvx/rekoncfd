import { useEffect, useState } from "react";
import { Apple, Check, Copy, Download, Monitor } from "lucide-react";

import { downloadUrlFor, fetchLatestRelease, macInstallCommand, WINDOWS_ASSET, type LatestRelease } from "@/lib/release";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

type ReleaseState = { status: "loading" } | { status: "ready"; release: LatestRelease } | { status: "unavailable" };

/** Renders the Mac install one-liner as a copyable code block instead of a
 * plain download button -- see `macInstallCommand`'s doc comment for why a
 * Terminal command, not a browser click, is the right default here without
 * an Apple Developer ID in the picture. */
function MacInstallCommand() {
  const [copied, setCopied] = useState(false);
  const command = macInstallCommand();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard API unavailable -- the command is still visible to copy by hand */
    }
  }

  return (
    <div className="border-border/60 bg-background/60 relative rounded-lg border p-3">
      <pre className="font-data text-muted-foreground overflow-x-auto text-[0.7rem] leading-relaxed whitespace-pre">
        {command}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy install command"
        className="text-muted-foreground hover:text-foreground hover:bg-accent absolute top-2 right-2 rounded-md p-1.5 transition-colors"
      >
        {copied ? <Check className="text-success size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/** The homepage's closing moment -- previously its own `/download` page,
 * folded in here since a standalone page competed with the homepage for the
 * same "convince someone to get the app" job. `/download` now just redirects
 * to `/#download` (see `App.tsx`) so old links still land somewhere sensible. */
export function DownloadSection() {
  const [release, setRelease] = useState<ReleaseState>({ status: "loading" });

  useEffect(() => {
    fetchLatestRelease()
      .then((release) => setRelease({ status: "ready", release }))
      .catch(() => setRelease({ status: "unavailable" }));
  }, []);

  return (
    <section id="download" className="glow-primary border-border/60 scroll-mt-20 border-t">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 px-6 pt-24 pb-10 text-center">
        <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">Download</span>
        <h2 className="text-3xl font-medium tracking-tight text-balance">Take Rekon with you</h2>
        <p className="text-muted-foreground max-w-xl text-balance">
          A standalone app for Windows or macOS — the same solver, the same UI, running fully offline on your own
          machine. It checks for new versions on launch and updates itself in place, so you only ever install it once.
        </p>
      </div>

      <div className="mx-auto grid max-w-3xl grid-cols-1 gap-4 px-6 pb-24 sm:grid-cols-2">
        <Card className="gap-3">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-lg">
                <Monitor className="size-5" />
              </div>
              <VersionBadge release={release} />
            </div>
            <CardTitle className="mt-3 text-lg tracking-tight">Windows</CardTitle>
            <CardDescription>Standalone .exe, no install — runs at 127.0.0.1 in your browser.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button asChild={release.status === "ready"} disabled={release.status !== "ready"} size="lg" className="w-full">
              {release.status === "ready" ? (
                <a href={downloadUrlFor(WINDOWS_ASSET)}>
                  <Download /> Download for Windows
                </a>
              ) : (
                <span>
                  <Download /> Download for Windows
                </span>
              )}
            </Button>
          </CardFooter>
        </Card>

        <Card className="gap-3">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-lg">
                <Apple className="size-5" />
              </div>
              <VersionBadge release={release} />
            </div>
            <CardTitle className="mt-3 text-lg tracking-tight">macOS</CardTitle>
            <CardDescription>Apple Silicon, installs via Terminal — no Gatekeeper warning.</CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-col items-stretch gap-2">
            <MacInstallCommand />
          </CardFooter>
        </Card>
      </div>
    </section>
  );
}

function VersionBadge({ release }: { release: ReleaseState }) {
  if (release.status !== "ready") return null;
  return (
    <Badge variant="secondary" className="font-data">
      v{release.release.version}
    </Badge>
  );
}
