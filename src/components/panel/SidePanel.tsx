import { Check, ChevronRight, Copy, Laptop, Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Activity, Health, Task } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ScreenView } from "@/components/preview/PreviewPanel";
import { Spinner, WaitingIcon } from "@/components/StatusIcon";
import { IconButton } from "@/components/ui/icon-button";
import { useChat } from "@/hooks/useChat";
import { collabStepTitle } from "@/lib/collab";
import { isLocal } from "@/lib/machines";
import { cn, compactNumber, duration } from "@/lib/utils";
import type { Machine } from "@/store/app";

const clock = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

/** A step's second line: what it did or how it ended, short. */
function detail(a: Activity): string {
  if (a.kind === "command") return a.exitCode !== undefined && a.exitCode !== 0 ? `exit ${a.exitCode}` : "";
  if (a.kind === "file_change" && a.changes?.length) return a.changes.map((c) => c.path.split("/").pop()).join(", ");
  if (a.error) return a.error;
  return "";
}

/** The whole conversation, step by step, with time and the agent that did it. */
function ActivityList() {
  const chat = useChat();
  const end = useRef<HTMLDivElement>(null);
  const runnerOf = new Map(chat.tasks.map((t) => [t.id, t.runner]));
  // Reasoning and notices are the agent's thinking, not something it did.
  const steps = chat.activities.filter((a) => a.kind !== "reasoning" && a.kind !== "notice").slice(-200);
  const waiting = chat.pendingQuestions;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [steps.length, chat.sessionId]);
  if (!steps.length && !waiting.length) {
    return <p className="px-1 text-xs text-muted-foreground">{chat.sessionId ? "No steps yet" : "Steps appear here as the agent works."}</p>;
  }
  return (
    <ol className="relative grid gap-3 pl-[18px] before:absolute before:bottom-1.5 before:left-1 before:top-1.5 before:w-px before:bg-border">
      {steps.map((a) => {
        const sub = detail(a);
        return (
          <li key={a.id} className="relative text-[12.5px]">
            <span className={cn(
              "absolute -left-[18px] top-[3px] grid size-[9px] place-items-center rounded-full border-[1.5px]",
              a.status === "running" ? "border-accent bg-background" : a.status === "failed" ? "border-danger bg-danger" : "border-success bg-success",
            )}>
              {a.status === "running" && <Spinner className="absolute size-[13px] border-[1.5px]" />}
            </span>
            <button type="button" className="grid w-full text-left hover:text-foreground"
              onClick={() => document.getElementById(`act-${a.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })}>
              <span className="flex min-w-0 items-center gap-1.5">
                <AgentAvatar runner={runnerOf.get(a.taskId)} size="sm" />
                <span className="min-w-0 flex-1 truncate">{collabStepTitle(a, chat.sessions) ?? a.title}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{clock(a.startedAt)}</span>
              </span>
              {sub && <span className={cn("truncate pl-5 text-[11.5px]", a.status === "failed" ? "text-danger" : "text-muted-foreground")}>{sub}</span>}
            </button>
          </li>
        );
      })}
      {waiting.map((q) => (
        <li key={q.id} className="relative text-[12.5px]">
          <WaitingIcon className="absolute -left-[20.5px] top-0" />
          <span className="font-medium text-warning">Needs you</span> <span className="text-muted-foreground">· {q.text}</span>
        </li>
      ))}
      <div ref={end} />
    </ol>
  );
}

function sum(tasks: Task[]) {
  let tokens = 0;
  let cost = 0;
  let ms = 0;
  for (const t of tasks) {
    const a = Date.parse(t.startedAt ?? ""), b = Date.parse(t.finishedAt ?? "");
    if (a && b && b > a) ms += b - a;
    if (!t.usage) continue;
    tokens += t.usage.inputTokens + t.usage.outputTokens;
    cost += t.usage.costUsd ?? 0;
  }
  return { tokens, cost, worked: ms ? duration(new Date(0).toISOString(), new Date(ms).toISOString()) : "" };
}

/** For advanced users, folded: where and how the conversation runs. */
function Details({ machine, health }: { machine: Machine; health?: Health }) {
  const chat = useChat();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const session = chat.session;
  const last = chat.currentTask;
  const first = chat.tasks[0];
  const runner = session?.runner ?? last?.runner;
  const folder = runner === "claude" && health?.claudeWorkdir ? health.claudeWorkdir : health?.workdir;
  const { tokens, cost, worked } = sum(chat.tasks);
  const model = [last?.model ?? session?.model, last?.effort ?? session?.effort].filter(Boolean).join(" · ");
  const Icon = isLocal(machine) ? Laptop : Monitor;
  const rows: [string, React.ReactNode][] = [
    ["Computer", <span className="flex items-center gap-1"><Icon className="size-3" />{machine.name}</span>],
    ...(folder ? [["Works in", <span className="truncate font-mono text-[11px]" title={folder}>{folder}</span>] as [string, React.ReactNode]] : []),
    ...(model ? [["Model", model] as [string, React.ReactNode]] : []),
    ...(first?.createdAt ? [["Started", `${new Date(first.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}${worked ? ` · worked ${worked}` : ""}`] as [string, React.ReactNode]] : []),
    ...(tokens ? [["Usage", `${compactNumber(tokens)} tokens${cost ? ` · $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : ""}`] as [string, React.ReactNode]] : []),
  ];
  return (
    <section className="border-t px-3 py-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex h-6 w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} /> Details
      </button>
      {open && (
        <dl className="mt-1 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1.5 pb-1 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 truncate">{v}</dd>
            </div>
          ))}
          {session && (
            <div className="contents">
              <dt className="text-muted-foreground">ID</dt>
              <dd className="flex min-w-0 items-center gap-1">
                <span className="truncate font-mono text-[11px]">{session.id}</span>
                <IconButton label={copied ? "Copied" : "Copy ID"} className="size-5" onClick={() => {
                  void navigator.clipboard.writeText(session.id);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}>
                  {copied ? <Check /> : <Copy />}
                </IconButton>
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

/**
 * The right panel (docs/desktop-redesign D5): another computer's screen on top, the conversation's
 * Activity, Details folded at the bottom. This computer has no screen here: the user is at it.
 */
export function SidePanel({ machine, health }: { machine: Machine; health?: Health }) {
  return (
    <aside className="flex h-full w-[328px] shrink-0 flex-col border-l bg-panel" aria-label="Side panel">
      {!isLocal(machine) && <ScreenView machine={machine} health={health} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <h3 className="sticky top-0 z-10 bg-panel pb-2 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Activity</h3>
        <ActivityList />
      </div>
      <Details machine={machine} health={health} />
    </aside>
  );
}
