import { AtSign, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Session } from "@/api/types";
import { Spinner } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useChat } from "@/hooks/useChat";
import { handleProblem, normalizeHandleInput, suggestHandle } from "@/lib/collab";
import { cn } from "@/lib/utils";

/**
 * Sets, changes, moves or removes a conversation's handle (mobd docs/agent-collaboration-design.md#handles).
 * A handle another conversation holds is only moved after the user confirms it here.
 */
export function HandleDialog({ session, onClose }: { session: Session | null; onClose: () => void }) {
  const chat = useChat();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** mobd said the handle is taken by a conversation not in the list (archived). */
  const [takenElsewhere, setTakenElsewhere] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const current = session?.handle ?? "";
  const suggested = session ? suggestHandle(session.title, chat.sessions.filter((s) => s.id !== session.id).flatMap((s) => (s.handle ? [s.handle] : []))) : "";

  useEffect(() => {
    if (!session) return;
    setValue(current || suggested);
    setError("");
    setTakenElsewhere("");
    setBusy(false);
    requestAnimationFrame(() => input.current?.select());
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const problem = value ? handleProblem(value) : "";
  const holder = chat.sessions.find((s) => s.handle === value && s.id !== session?.id);
  const moving = !problem && (!!holder || takenElsewhere === value);
  const unchanged = value === current;
  const canSave = !!value && !problem && !unchanged && !busy;

  async function save(handle: string, take: boolean) {
    if (!session) return;
    setBusy(true);
    const err = await chat.setHandle(session.id, handle, take);
    setBusy(false);
    if (!err) {
      toast.success(!handle ? `Removed @${current}` : take ? `Moved @${handle} to this conversation` : `This agent is now @${handle}`);
      onClose();
    } else if (/belongs to another conversation/.test(err)) {
      setTakenElsewhere(handle);
    } else setError(err);
  }

  return (
    <Dialog open={!!session} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="w-[440px] p-5" showClose={false}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) void save(value, moving);
          }}
        >
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <AtSign className="size-4.5" />
            </span>
            <div className="min-w-0">
              <DialogTitle>{current ? "Change handle" : "Give this agent a handle"}</DialogTitle>
              <DialogDescription className="mt-0.5 truncate" title={session?.title}>
                {session?.title}{session?.runner ? ` · ${session.runner}` : ""}
              </DialogDescription>
            </div>
          </div>

          <div
            className={cn(
              "mt-4 flex h-10 items-center rounded-lg border bg-background px-3 transition-shadow focus-within:border-accent focus-within:ring-3 focus-within:ring-ring/40",
              (problem || error) && "border-danger focus-within:border-danger",
            )}
          >
            <span className="select-none font-mono text-[15px] text-muted-foreground">@</span>
            <input
              ref={input}
              aria-label="Handle"
              value={value}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder="order-service"
              maxLength={32}
              onChange={(e) => {
                setValue(normalizeHandleInput(e.target.value));
                setError("");
              }}
              className="min-w-0 flex-1 bg-transparent pl-0.5 font-mono text-[15px] outline-none placeholder:text-muted-foreground/50"
            />
            <span className="shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">{value.length}/32</span>
          </div>

          <p className={cn("mt-1.5 min-h-4 text-xs", problem || error ? "text-danger" : "text-muted-foreground")}>
            {problem || error || "Lowercase letters, digits and -. Unique on this office computer."}
          </p>

          {!current && suggested && value !== suggested && (
            <button type="button" onClick={() => { setValue(suggested); input.current?.focus(); }}
              className="mt-1 rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-foreground/80 hover:bg-accent-soft">
              Use @{suggested}
            </button>
          )}

          {moving ? (
            <div className="mt-3 flex gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
              <p>
                <span className="font-mono font-medium">@{value}</span> belongs to{" "}
                {holder ? <span className="font-medium">"{holder.title}"</span> : "an archived conversation"}. Moving it leaves that
                conversation without a handle; its past requests keep their names.
              </p>
            </div>
          ) : (
            <p className="mt-3 rounded-lg bg-panel p-3 text-xs text-muted-foreground">
              In another conversation, type <span className="font-mono text-foreground">@{value && !problem ? value : "handle"}</span> to
              ask this agent for help. The title keeps describing its work.
            </p>
          )}

          <div className="mt-5 flex items-center gap-2">
            {current && (
              <Button type="button" variant="ghost" size="sm" className="text-danger hover:bg-danger/10 hover:text-danger" disabled={busy}
                onClick={() => void save("", false)}>
                Remove @{current}
              </Button>
            )}
            <span className="flex-1" />
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={!canSave}>
              {busy && <Spinner className="size-3" />}
              {moving ? `Move @${value} here` : current ? "Save" : "Set handle"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
