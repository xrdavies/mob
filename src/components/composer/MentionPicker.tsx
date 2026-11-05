import { useEffect, useRef } from "react";
import type { Session } from "@/api/types";
import { Kbd } from "@/components/ui/kbd";
import { mentionCandidates, shortId } from "@/lib/collab";
import { cn } from "@/lib/utils";

const RUNNER_LABELS: Record<string, string> = { codex: "Codex", claude: "Claude Code", pi: "Pi" };

/**
 * Agents you can @-mention, shown above the composer while an @ word is being typed: agents with a
 * handle first, then other conversations. Picking one without a handle offers to name it first
 * (`naming`), so mentions stay readable.
 */
export function MentionPicker({ sessions, query, self, active, naming, onPick, onName, onPlain }: {
  sessions: Session[];
  query: string;
  self: string | null;
  active: number;
  naming: { session: Session; handle: string } | null;
  onPick: (s: Session) => void;
  onName: () => void;
  onPlain: () => void;
}) {
  const list = mentionCandidates(sessions, query, self);
  const row = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    row.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const box = "absolute bottom-full left-3 right-3 z-20 mb-2 rounded-xl border bg-popover p-1 shadow-panel";
  // Buttons keep the textarea focused, so the caret and the @ word stay where they were.
  const keep = (e: React.MouseEvent) => e.preventDefault();

  if (naming) {
    return (
      <div role="dialog" aria-label="Name this agent" className={cn(box, "p-3")}>
        <p className="text-[13px]">
          Give <span className="font-medium">{naming.session.title}</span> a handle?
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">You and other agents can then mention it by name instead of its ID.</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {naming.handle && (
            <button type="button" onMouseDown={keep} onClick={onName}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-foreground hover:bg-accent/90">
              Name it <span className="font-mono">@{naming.handle}</span> <Kbd className="border-white/30 bg-white/15 text-white">↵</Kbd>
            </button>
          )}
          <button type="button" onMouseDown={keep} onClick={onPlain}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-muted">
            Mention as <span className="font-mono">@{shortId(naming.session.id)}</span> <Kbd>Tab</Kbd>
          </button>
          <span className="ml-auto text-[11px] text-muted-foreground">Esc to go back</span>
        </div>
      </div>
    );
  }

  if (list.length === 0) return null;
  return (
    <div role="listbox" aria-label="Mention an agent" className={cn(box, "max-h-72 overflow-y-auto")}>
      {list.map((s, i) => {
        const header = i === 0 || !!list[i - 1].handle !== !!s.handle ? (s.handle ? "Agents" : "Conversations") : null;
        return (
          <div key={s.id}>
            {header && <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{header}</p>}
            <button
              ref={i === active ? row : undefined}
              type="button"
              role="option"
              aria-selected={i === active}
              aria-disabled={!!s.archived}
              onMouseDown={(e) => {
                keep(e);
                if (!s.archived) onPick(s);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                i === active && !s.archived && "bg-accent-soft",
                s.archived && "cursor-default text-muted-foreground/60",
              )}
            >
              {s.handle && <span className="shrink-0 font-mono font-medium">@{s.handle}</span>}
              <span className={cn("min-w-0 flex-1 truncate", s.handle && "text-muted-foreground")}>{s.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {s.archived ? "archived" : [!s.handle && shortId(s.id), RUNNER_LABELS[s.runner ?? ""] ?? s.runner].filter(Boolean).join(" · ")}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
