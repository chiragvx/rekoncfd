import { NavLink } from "react-router-dom";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { RekonLogo } from "@/components/RekonLogo";

const NAV_LINKS = [
  { to: "/explore", label: "Explore Models" },
  { to: "/airfoils", label: "Airfoil Generator" },
  { to: "/#download", label: "Download" },
];

/** Persistent top nav for the marketing/browsing pages (Landing, Explore,
 * Airfoil Generator) -- deliberately NOT rendered on `/tool`, which wants
 * every pixel for the 3D viewport and its overlay panels. */
export function SiteHeader() {
  return (
    <header className="border-border/60 bg-background/75 sticky top-0 z-20 border-b backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <NavLink to="/" aria-label="Rekon home">
          <RekonLogo className="text-foreground h-5 w-auto" />
        </NavLink>

        <nav className="flex items-center gap-1">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                cn(
                  "hidden rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:block",
                  isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {link.label}
            </NavLink>
          ))}
          <Button asChild size="sm" className="ml-0 sm:ml-2">
            <NavLink to="/tool">Open Tool</NavLink>
          </Button>
        </nav>
      </div>
    </header>
  );
}
