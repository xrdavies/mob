import { Check, CircleSlash, X } from "lucide-react";
import type { TaskStatus } from "@/api/types";
import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-label="Running"
      className={cn("inline-block size-3.5 shrink-0 animate-spin-slow rounded-full border-[1.5px] border-accent border-t-transparent", className)}
    />
  );
}

/** Needs you: the agent waits for the user's answer or approval (an amber diamond, as everywhere). */
export function WaitingIcon({ className }: { className?: string }) {
  return (
    <span aria-label="Needs you" className={cn("inline-flex size-3.5 shrink-0 items-center justify-center", className)}>
      <span className="size-2 rotate-45 rounded-[2px] bg-warning" />
    </span>
  );
}

/**
 * The five states (docs/desktop-redesign D-status): Working (spinner), Needs you (WaitingIcon), Queued
 * (dashed circle), Done (green check, only with showDone; silent elsewhere), Failed (red cross).
 * Shape and color together, so they never depend on color alone.
 */
export function StatusIcon({ status, position, showDone, className }: {
  status: TaskStatus; position?: number; showDone?: boolean; className?: string;
}) {
  switch (status) {
    case "running":
      return <Spinner className={className} />;
    case "queued":
      return (
        <span
          aria-label={position ? `Queued #${position}` : "Queued"}
          title={position ? `Queued #${position}` : "Queued"}
          className={cn("inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full border-[1.5px] border-dashed border-muted-foreground/70 px-0.5 text-[9px] font-semibold leading-none text-muted-foreground", className)}
        >
          {position ?? ""}
        </span>
      );
    case "succeeded":
      return showDone ? <Check aria-label="Done" strokeWidth={3} className={cn("size-3.5 text-success", className)} /> : null;
    case "failed":
      return (
        <span aria-label="Failed" className={cn("inline-flex size-3.5 items-center justify-center rounded-full bg-danger text-white", className)}>
          <X className="size-2.5" strokeWidth={3} />
        </span>
      );
    case "cancelled":
      return <CircleSlash aria-label="Cancelled" className={cn("size-3.5 text-muted-foreground", className)} />;
    default:
      return null;
  }
}
