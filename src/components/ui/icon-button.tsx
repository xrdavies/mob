import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A secondary action shown as an icon (docs/desktop-redesign D9): rename, choose folder, refresh,
 * copy, open, restart, stop. The label is required: it is the tooltip and what screen readers say.
 * Primary and destructive actions keep a text Button.
 */
export function IconButton({ label, shortcut, side, className, children, ...props }: Omit<ComponentProps<typeof Button>, "size" | "variant"> & {
  label: string;
  /** Shown after the label in the tooltip, e.g. "⌘N". */
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <Tooltip side={side} content={shortcut ? <>{label} <span className="opacity-60">{shortcut}</span></> : label}>
      <Button variant="ghost" size="icon-sm" aria-label={label} className={cn(className)} {...props}>
        {children}
      </Button>
    </Tooltip>
  );
}
