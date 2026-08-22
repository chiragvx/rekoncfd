import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Compass, LoaderCircle, Wind } from "lucide-react";

import { engine } from "@/lib/engine";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

interface SampleModelSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export function ExplorePage() {
  const navigate = useNavigate();
  const [models, setModels] = useState<SampleModelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/models")
      .then((res) => {
        if (!res.ok) throw new Error(`failed to load models (${res.status})`);
        return res.json();
      })
      .then(setModels)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function openModel(id: string) {
    setLoadingId(id);
    try {
      await engine.loadSampleModel(id);
      navigate("/tool");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoadingId(null);
    }
  }

  return (
    <div className="bg-background min-h-screen">
      <SiteHeader />

      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-12 flex flex-col gap-3">
          <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">Gallery</span>
          <h1 className="text-4xl font-medium tracking-tight text-balance">Explore Models</h1>
          <p className="text-muted-foreground max-w-2xl text-balance">
            A starting gallery of ready-to-fly planforms — one click loads a model straight into the tool at its
            trimmed condition. Every entry below is procedurally generated with the Airfoil Generator, not a real
            aircraft scan; a curated library of real STL models is coming next.
          </p>
        </div>

        {error && <p className="text-destructive mb-6 text-sm">{error}</p>}

        {!models && !error && (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <LoaderCircle className="size-4 animate-spin" /> Loading catalog…
          </div>
        )}

        {models && models.length === 0 && (
          <Card className="max-w-lg">
            <CardHeader>
              <Compass className="text-muted-foreground size-6" />
              <CardTitle className="mt-1">No models yet</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">
                The catalog is empty. Add entries to the server's sample catalog, or design one yourself with the
                Airfoil Generator.
              </p>
            </CardContent>
          </Card>
        )}

        {models && models.length > 0 && (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {models.map((m) => (
              <Card key={m.id} className="surface-interactive gap-0 overflow-hidden py-0">
                <div className="glow-primary border-border/60 relative flex h-24 items-center justify-center border-b">
                  <Wind className="text-primary/50 size-9" strokeWidth={1.25} />
                </div>
                <div className="flex flex-1 flex-col gap-3 p-4">
                  <CardHeader className="p-0">
                    <CardTitle className="text-base tracking-tight">{m.name}</CardTitle>
                    <CardDescription className="text-xs leading-relaxed">{m.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-1.5 p-0">
                    {m.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="font-data text-[10px] tracking-wide">
                        {tag}
                      </Badge>
                    ))}
                  </CardContent>
                  <CardFooter className="mt-1 p-0">
                    <Button size="sm" className="w-full" disabled={loadingId === m.id} onClick={() => openModel(m.id)}>
                      {loadingId === m.id ? (
                        <>
                          <LoaderCircle className="animate-spin" /> Loading…
                        </>
                      ) : (
                        <>
                          Open in Tool <ArrowRight />
                        </>
                      )}
                    </Button>
                  </CardFooter>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
      <SiteFooter />
    </div>
  );
}
