import { useState } from "react";
import { NavLink } from "react-router-dom";

import { useEngineEvent } from "@/lib/engine";
import { isSupabaseConfigured } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { RekonMark } from "@/components/RekonMark";
import { AccountControl } from "@/components/AccountControl";
import { ProjectMenu } from "@/components/ProjectMenu";
import { SettingsMenu } from "@/components/SettingsMenu";

const NAV_LINKS = [
  { to: "/explore", label: "Explore Models" },
  { to: "/airfoils", label: "Airfoil Generator" },
  { to: "/#download", label: "Download" },
];

const AXIS_LEGEND = "X→flow, Y↑, Z=span";

/** Full-width top bar for the tool page -- same brand mark and nav links as
 * `SiteHeader`, so moving between the marketing pages and the tool never
 * loses the sense that it's one app, but `fixed` (not `sticky`) since the
 * tool page has no normal document scroll to stick within, and translucent
 * so it reads as a HUD element over the 3D viewport rather than a full
 * opaque bar competing with it for screen space.
 *
 * Also the single home for every always-visible HUD readout (connection
 * status, mesh size, axis legend) -- these used to live in a separate
 * top-left overlay, which put them on a direct collision course with the
 * side panels once those also started flush at the top of the screen. */
export function ToolNav() {
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [meshLine, setMeshLine] = useState<string | null>(null);

  useEngineEvent("wsStatus", setStatus);
  useEngineEvent("meshGeometry", (decoded) => {
    setMeshLine(`${decoded.vertexCount.toLocaleString()} verts / ${decoded.triangleCount.toLocaleString()} tris`);
  });
  useEngineEvent("meshCleared", () => setMeshLine(null));

  return (
    <header className="border-border/60 bg-background/85 fixed inset-x-0 top-0 z-20 border-b backdrop-blur-md">
      <div className="flex h-14 items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <NavLink to="/" className="font-display flex items-center gap-2 text-[0.95rem] font-medium tracking-tight">
            <RekonMark className="text-primary size-5" />
            Rekon
          </NavLink>
          <div className="font-data text-muted-foreground hidden items-center gap-3 border-l pl-4 text-xs sm:flex">
            {meshLine && <span>{meshLine}</span>}
            <span>{AXIS_LEGEND}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <nav className="flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                  )
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>

          <Badge variant={status === "open" ? "success" : status === "connecting" ? "secondary" : "destructive"}>
            {status}
          </Badge>

          <div className="bg-border h-5 w-px" />
          <SettingsMenu />

          {isSupabaseConfigured && (
            <>
              <div className="bg-border h-5 w-px" />
              <ProjectMenu />
            </>
          )}

          <AccountControl />
        </div>
      </div>
    </header>
  );
}
