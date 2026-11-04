import { useEffect, useRef } from "react";
import type { Session } from "@/api/types";
import { agentLabel, mentionCandidates, mentionToken } from "@/lib/collab";
import { cn } from "@/lib/utils";

/** Agents you can @-mention, shown above the composer while an @ word is being typed. */
export function MentionPicker({ sessions, query, self, active, onPick }: {
  sessions: Session[];
  query: string;
  self: string | null;
  active: number;
  onPick: (s: Session, token: string) => void;
}) {
  const list = mentionCandidates(sessions, query, self);
  const row = useRef<HTMLButtonElement>(null);
  useEffect(() => row.current?.scrollIntoView({ block: "nearest" }), [active]);
  if (list.length === 0) return null;
  return (
    <div role="listbox" aria-label="Mention an agent" className="absolute bottom-full left-3 right-3 mb-2 max-h-64 overflow-y-auto rounded-xl border bg-popover p-1 shadow-panel">
      {list.map((s, i) => (
        <button
          key={s.id}
          ref={i === active ? row : undefined}
          type="button"
          role="option"
          aria-selected={i === active}
          aria-disabled={!!s.archived}
          onMouseDown={(e) => {
            // Keeps the textarea focused.
            e.preventDefault();
            if (!s.archived) onPick(s, mentionToken(s));
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
            i === active && !s.archived && "bg-accent-soft",
            s.archived && "cursor-default text-muted-foreground/60",
          )}
        >
          <span className={cn("min-w-0 flex-1 truncate", s.handle ? "font-medium" : "")}>{agentLabel(s)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {s.archived ? "archived" : s.runner}
          </span>
        </button>
      ))}
    </div>
  );
}
