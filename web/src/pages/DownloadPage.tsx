import { useEffect, useState } from "react";
import { Box, Download, LoaderCircle, Monitor } from "lucide-react";

import { downloadUrlFor, fetchLatestRelease, type LatestRelease } from "@/lib/release";
import { SiteHeader } from "@/components/SiteHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

const WINDOWS_ASSET = "rekon-app-x86_64-pc-windows-msvc.exe";

type ReleaseState = { status: "loading" } | { status: "ready"; release: LatestRelease } | { status: "unavailable" };

export function DownloadPage() {
  const [release, setRelease] = useState<ReleaseState>({ status: "loading" });

  useEffect(() => {
    fetchLatestRelease()
      .then((release) => setRelease({ status: "ready", release }))
      .catch(() => setRelease({ status: "unavailable" }));
  }, []);

  return (
    <div className="bg-background min-h-screen">
      <SiteHeader />

      <section className="mx-auto max-w-5xl px-6 py-20">
        <div className="mb-12 flex flex-col gap-3">
          <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">Download</span>
          <h1 className="text-4xl font-medium tracking-tight text-balance">Take Rekon with you</h1>
          <p className="text-muted-foreground max-w-2xl text-balance">
            A single standalone executable — the same solver, the same UI, running fully offline on your own
            machine. It checks for new versions on launch and updates itself in place, so you only ever download it
            once.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
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
              <Button
                asChild={release.status === "ready"}
                disabled={release.status !== "ready"}
                size="lg"
                className="w-full"
              >
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

          <Card className="gap-4 opacity-70">
            <CardHeader>
              <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-lg">
                <Box className="size-5" />
              </div>
              <CardTitle className="mt-3 flex items-center gap-2 text-lg tracking-tight">
                DWG Import
                <Badge variant="secondary" className="text-[10px]">
                  Coming soon
                </Badge>
              </CardTitle>
              <CardDescription>
                Import AutoCAD DWG drawings directly, alongside STL, as a source geometry format.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">
                Not available yet — planform and section geometry authored in DWG will feed the same import pipeline
                STL uses today.
              </p>
            </CardContent>
            <CardFooter>
              <Button size="lg" variant="secondary" disabled className="w-full">
                Not yet available
              </Button>
            </CardFooter>
          </Card>
        </div>
      </section>
    </div>
  );
}
