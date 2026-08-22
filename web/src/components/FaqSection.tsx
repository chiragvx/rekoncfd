import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export interface FaqEntry {
  q: string;
  a: string;
}

/** Exported (not just used internally) so `LandingPage` can build the
 * `FAQPage` JSON-LD structured-data block from this SAME array rather than a
 * second copy of the same questions/answers -- the two have to stay
 * word-for-word identical for the structured data to be valid. */
export const FAQS: FaqEntry[] = [
  {
    q: "Is Rekon free?",
    a: "Yes. Both the hosted web preview and the downloadable desktop app (Windows or macOS) are free.",
  },
  {
    q: "Do I need an internet connection to use it?",
    a: "The hosted page at rekoncfd.vercel.app is a preview shell with no backend of its own — it can't actually solve anything. The downloaded desktop app runs a local server on your own machine and solves fully offline; it only touches the network to check for a new version on launch.",
  },
  {
    q: "What file formats can I import?",
    a: "STL. If the auto-detected orientation or unit is wrong, you can override the axis mapping and unit manually after import. You can also skip import entirely and generate a wing from a NACA 4- or 5-digit airfoil section.",
  },
  {
    q: "How accurate is the solver?",
    a: "Rekon uses a source-doublet panel method for lift, drag, and moment, plus a D3Q19 lattice-Boltzmann solver for the 3D flow field. It's accurate enough to guide real design decisions on typical thin-to-moderate-thickness RC flying-wing planforms — tapered, swept, twisted — though like any panel method it's best suited to lifting surfaces rather than bluff bodies.",
  },
  {
    q: "Is Rekon open source?",
    a: "Yes, the full source is available on GitHub at github.com/chiragvx/rekoncfd.",
  },
  {
    q: "What platforms does the desktop app support?",
    a: "Windows, as a single standalone .exe with no installer or admin rights required, and macOS on Apple Silicon, installed via a short Terminal command.",
  },
];

function FaqItem({ entry, defaultOpen }: { entry: FaqEntry; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-border/60 border-b py-5 first:pt-0 last:border-b-0">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-4 text-left">
        <span className="font-medium tracking-tight">{entry.q}</span>
        <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{entry.a}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function FaqSection() {
  return (
    <section aria-labelledby="faq-heading" className="border-border/60 border-t">
      <div className="mx-auto max-w-3xl px-6 py-24">
        <div className="mb-6 flex flex-col gap-3">
          <span className="text-primary font-data text-xs tracking-[0.2em] uppercase">FAQ</span>
          <h2 id="faq-heading" className="text-3xl font-medium tracking-tight text-balance">
            Questions people actually ask
          </h2>
        </div>
        <div>
          {FAQS.map((entry, i) => (
            <FaqItem key={entry.q} entry={entry} defaultOpen={i === 0} />
          ))}
        </div>
      </div>
    </section>
  );
}
