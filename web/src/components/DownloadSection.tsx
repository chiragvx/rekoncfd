import { useEffect, useState } from "react";
import { Download, LoaderCircle, Monitor } from "lucide-react";

import { downloadUrlFor, fetchLatestRelease, type LatestRelease } from "@/lib/release";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

const WINDOWS_ASSET = "rekon-app-x86_64-pc-windows-msvc.exe";

type ReleaseState = { status: "loading" } | { status: "ready"; release: LatestRelease } | { status: "unavailable" };

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
          A single standalone executable — the same solver, the same UI, running fully offline on your own machine.
          It checks for new versions on launch and updates itself in place, so you only ever download it once.
        </p>
      </div>

      <div className="mx-auto max-w-md px-6 pb-24">
        <Card className="gap-4">
          <CardHeader>
            <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-lg">
              <Monitor className="size-5" />
            </div>
            <CardTitle className="mt-3 text-lg tracking-tight">Windows Desktop App</CardTitle>
            <CardDescription>Standalone .exe — no install, no dependencies, runs at 127.0.0.1 in your browser.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {release.status === "loading" && (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <LoaderCircle className="size-4 animate-spin" /> Checking latest release…
              </div>
            )}
            {release.status === "ready" && (
              <div className="font-data text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <Badge variant="secondary" className="font-data">
                  v{release.release.version}
                </Badge>
                <span>published {new Date(release.release.publishedAt).toLocaleDateString()}</span>
              </div>
            )}
            {release.status === "unavailable" && (
              <p className="text-muted-foreground text-sm">
                No release is published yet — check back soon, or build from source in the meantime.
              </p>
            )}

            <Separator />

            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <span className="bg-success size-1.5 shrink-0 rounded-full" />
              Auto-updates in the background — download once, stay current.
            </div>
          </CardContent>
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
      </div>
    </section>
  );
}
