import { useState, type ComponentType } from "react";
import { Box, Grid3x3 } from "lucide-react";

import { engine } from "@/lib/engine";
import { cn } from "@/lib/utils";

function ToolbarToggle({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
        active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-accent",
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}

/** Floating strip over the 3D viewport for scene/environment chrome --
 * distinct from the Visualization panel's flow-field toggles (pressure,
 * streamlines, ...), which only mean anything once a mesh/solve exists.
 * Ground and the wind-tunnel wireframe are always-available reference
 * geometry, so they get their own always-visible control. */
export function ViewportToolbar() {
  const [ground, setGround] = useState(true);
  const [walls, setWalls] = useState(true);

  return (
    <div className="border-border/60 bg-card/90 absolute bottom-4 left-4 z-10 flex items-center gap-1 rounded-lg border p-1 backdrop-blur-sm">
      <ToolbarToggle
        active={ground}
        icon={Grid3x3}
        label="Ground"
        onClick={() => {
          const next = !ground;
          setGround(next);
          engine.setGroundVisible(next);
        }}
      />
      <ToolbarToggle
        active={walls}
        icon={Box}
        label="Wind tunnel"
        onClick={() => {
          const next = !walls;
          setWalls(next);
          engine.setWallsVisible(next);
        }}
      />
    </div>
  );
}
