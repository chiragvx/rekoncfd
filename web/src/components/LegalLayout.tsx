import type { ReactNode } from "react";

import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

/** Shared shell for the Privacy Policy and Terms of Use pages -- plain prose
 * on the same dark background and container width as the marketing pages,
 * rather than a one-off layout for two pages that will rarely change. */
export function LegalLayout({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="bg-background min-h-screen">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-6 py-20">
        <h1 className="text-4xl font-medium tracking-tight text-balance">{title}</h1>
        <p className="text-muted-foreground mt-2 text-sm">Last updated {updated}</p>
        <div className="legal-prose mt-10 flex flex-col gap-8">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}
