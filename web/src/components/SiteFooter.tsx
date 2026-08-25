import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";

import { RekonLogo } from "@/components/RekonLogo";
import { NewsletterForm } from "@/components/NewsletterForm";

const LINK_GROUPS = [
  {
    heading: "Product",
    links: [
      { to: "/tool", label: "Open Tool" },
      { to: "/explore", label: "Explore Models" },
      { to: "/airfoils", label: "Airfoil Generator" },
    ],
  },
  {
    heading: "Get Rekon",
    links: [
      { to: "/#download", label: "Download for Windows / macOS" },
      { to: "https://github.com/chiragvx/rekoncfd", label: "Source on GitHub", external: true },
      { to: "https://github.com/chiragvx/rekoncfd/releases", label: "Release notes", external: true },
    ],
  },
  {
    heading: "Legal",
    links: [
      { to: "/privacy", label: "Privacy Policy" },
      { to: "/terms", label: "Terms of Use" },
    ],
  },
];

/** Shared footer for every marketing page -- internal links to the actual
 * content pages (good for both ordinary crawlers and an LLM agent following
 * links from `llms.txt`), plus the one piece of provenance info a visitor
 * deciding whether to trust the download needs close at hand: a direct link
 * to the public source. */
export function SiteFooter() {
  return (
    <footer className="border-border/60 border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-14">
        <div className="flex flex-col gap-8 sm:flex-row sm:justify-between">
          <div className="flex max-w-xs flex-col gap-3">
            <Link to="/" aria-label="Rekon home">
              <RekonLogo className="text-foreground h-5 w-auto" />
            </Link>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Free, open-source aerodynamic analysis for RC flying wings — a live panel-method solver and an
              on-demand lattice-Boltzmann flow field, in your browser or fully offline.
            </p>
            <a
              href="https://github.com/chiragvx/rekoncfd"
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground mt-1 flex w-fit items-center gap-1.5 text-sm transition-colors"
            >
              <ExternalLink className="size-4" />
              chiragvx/rekoncfd
            </a>
            <div className="mt-3">
              <NewsletterForm source="footer" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
            {LINK_GROUPS.map((group) => (
              <div key={group.heading} className="flex flex-col gap-2.5">
                <span className="text-muted-foreground font-data text-[11px] tracking-[0.15em] uppercase">
                  {group.heading}
                </span>
                {group.links.map((link) =>
                  link.external ? (
                    <a
                      key={link.label}
                      href={link.to}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      key={link.label}
                      to={link.to}
                      className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                    >
                      {link.label}
                    </Link>
                  ),
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="border-border/60 text-muted-foreground/70 font-data flex flex-col gap-2 border-t pt-6 text-xs sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} Rekon. Open source on GitHub, MIT licensed.</span>
          <span>Built with a source-doublet panel method and a D3Q19 lattice-Boltzmann solver.</span>
        </div>
      </div>
    </footer>
  );
}
