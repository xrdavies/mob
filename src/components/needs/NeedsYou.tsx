import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { answerQuestion, fetchSessionDetail } from "@/api/client";
import type { Question } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ComputerIcon } from "@/components/ComputerIcon";
import { QuestionCard, type Reply } from "@/components/timeline/QuestionCard";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { chat } from "@/hooks/useChat";
import { useNeedsYou } from "@/hooks/useComputers";
import { openSession } from "@/hooks/navigate";
import type { Waiting } from "@/lib/computers";

import { cn, shortAgo } from "@/lib/utils";
import { baseUrl, useApp } from "@/store/app";

/** One waiting conversation: its pending questions, answered here. */
function WaitingCard({ w, selected, onSelect }: { w: Waiting; selected: boolean; onSelect: () => void }) {
  const qc = useQueryClient();
  const machine = useApp((s) => s.machines.find((m) => m.id === w.machineId));
  const base = baseUrl(machine);
  const key = ["needs", base, w.session.id, w.session.updatedAt];
  const { data, isLoading, isError } = useQuery({
    queryKey: key,
    queryFn: () => fetchSessionDetail(base, w.session.id),
    enabled: !!base,
    staleTime: 30_000,
  });
  const pending = (data?.questions ?? []).filter((q) => q.status === "pending");
  const answer = async (q: Question, reply: Reply) => {
    try {
      await answerQuestion(base, q, reply);
      // The open conversation shows the answer at once; others update from their stream.
      if (chat.machineId === w.machineId && chat.sessionId === w.session.id) chat.resync();
      void qc.invalidateQueries({ queryKey: ["needs", base, w.session.id] });
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  if (!machine) return null;
  const header = (
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <AgentAvatar runner={w.session.runner} size="sm" />
      {w.session.handle && <span className="text-foreground/80">@{w.session.handle} ·</span>}
      <span className="truncate font-medium text-foreground/80">{w.session.title}</span>·
      <ComputerIcon machine={machine} className="size-3 shrink-0" /> <span className="shrink-0">{machine.name}</span>
      {w.session.updatedAt && <span className="shrink-0">· {shortAgo(w.session.updatedAt)}</span>}
    </p>
  );
  return (
    <div onFocusCapture={onSelect} onMouseDown={onSelect} data-needs-card={w.session.id}
      className={cn("rounded-xl", selected && "ring-2 ring-ring ring-offset-2 ring-offset-background")}>
      {pending.length ? pending.map((q) => <QuestionCard key={q.id} q={q} onAnswer={answer} className="ml-0" header={header} />) : (
        <div className="rounded-xl border border-warning/40 bg-warning/5 p-3.5">
          {header}
          <p className="mt-1 text-[13px] text-muted-foreground">{isLoading ? "Loading…" : isError ? "Could not load the question." : "Answered"}</p>
        </div>
      )}
      <div className="mt-1 flex justify-end">
        <Button variant="link" size="sm" className="h-6 px-1 text-xs" onClick={() => openSession(w.machineId, w.session.id)}>Open conversation</Button>
      </div>
    </div>
  );
}

/** Every question and approval waiting on any computer (docs/desktop-redesign D4). */
export function NeedsYou() {
  const waiting = useNeedsYou();
  const computers = new Set(waiting.map((w) => w.machineId)).size;
  const [selected, setSelected] = useState(0);
  const sel = Math.min(selected, Math.max(0, waiting.length - 1));

  // ↑/↓ choose; A approves and D denies the chosen approval (the card's own buttons).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, [contenteditable]")) return;
      const k = e.key.toLowerCase();
      if (k === "arrowdown" || k === "j") setSelected((i) => Math.min(i + 1, waiting.length - 1));
      else if (k === "arrowup" || k === "k") setSelected((i) => Math.max(i - 1, 0));
      else if (k === "a" || k === "d" || k === "enter") {
        const card = document.querySelector(`[data-needs-card="${waiting[sel]?.session.id}"]`);
        const label = k === "a" ? "Approve" : k === "d" ? "Deny" : "Open conversation";
        const button = [...(card?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === label);
        if (button) {
          e.preventDefault();
          button.click();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [waiting, sel]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-7 py-7">
      <div className="mx-auto grid max-w-[720px] gap-3">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-lg font-semibold">Needs you</h1>
          {waiting.length > 0 && (
            <span className="text-xs text-muted-foreground">{waiting.length} waiting on {computers} computer{computers > 1 ? "s" : ""}</span>
          )}
          {waiting.length > 0 && (
            <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground"><Kbd>A</Kbd> approve <Kbd>D</Kbd> deny</span>
          )}
        </div>
        {waiting.map((w, i) => <WaitingCard key={`${w.machineId}/${w.session.id}`} w={w} selected={i === sel && waiting.length > 1} onSelect={() => setSelected(i)} />)}
        {!waiting.length && (
          <div className="mt-16 grid justify-items-center gap-3 text-center text-[13px] text-muted-foreground">
            <img src="/logo.svg" alt="" className="size-16 opacity-90" />
            Nothing is waiting for you.
          </div>
        )}
      </div>
    </div>
  );
}
