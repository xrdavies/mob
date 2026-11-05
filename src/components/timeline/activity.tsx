import {
  AppWindow, Brain, Camera, ChevronRight, CircleHelp, FileDiff, ShieldAlert, Globe, Keyboard, ListChecks, MousePointerClick,
  SquareTerminal, TriangleAlert, Wrench, type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { artifactUrl } from "@/api/client";
import type { Activity } from "@/api/types";
import { AuthImage } from "@/components/AuthImage";
import { Spinner } from "@/components/StatusIcon";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useChat } from "@/hooks/useChat";
import { collabStepTitle } from "@/lib/collab";
import { cn, duration } from "@/lib/utils";

export function activityIcon(a: Activity): LucideIcon {
  if (a.kind === "tool") {
    switch (a.tool) {
      case "click":
        return MousePointerClick;
      case "type_text":
      case "key":
        return Keyboard;
      case "screenshot":
        return Camera;
      case "open_app":
      case "list_windows":
        return AppWindow;
      case "ask_user":
        return CircleHelp;
      case "request_approval":
        return ShieldAlert;
    }
    return Wrench;
  }
  return ({
    command: SquareTerminal, reasoning: Brain, plan: ListChecks, file_change: FileDiff, web_search: Globe, notice: TriangleAlert,
  } as Record<string, LucideIcon>)[a.kind] ?? Wrench;
}

function StepStatus({ a }: { a: Activity }) {
  if (a.kind === "notice") return null;
  if (a.status === "running") return <Spinner className="size-3" />;
  if (a.status === "failed") return <span className="size-1.5 rounded-full bg-danger" aria-label="Failed" />;
  return <span className="size-1.5 rounded-full bg-success/70" aria-label="Done" />;
}

function Mono({ children, className }: { children: string; className?: string }) {
  const [all, setAll] = useState(false);
  const lines = children.split("\n");
  const long = lines.length > 12;
  return (
    <div className={cn("rounded-md border bg-code", className)}>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-foreground/85">
        {long && !all ? lines.slice(0, 12).join("\n") : children}
      </pre>
      {long && (
        <button type="button" onClick={() => setAll(!all)} className="w-full border-t py-1 text-[11px] text-muted-foreground hover:text-foreground">
          {all ? "Show less" : `Show ${lines.length - 12} more lines`}
        </button>
      )}
    </div>
  );
}

function Details({ a, base }: { a: Activity; base: string }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const args = a.arguments && Object.entries(a.arguments);
  return (
    <div className="grid gap-2 pb-1 pl-[26px] pr-1 pt-1.5 text-xs">
      {a.kind === "tool" && args && args.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {args.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-all font-mono text-[11.5px]">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {a.kind === "command" && a.command && <Mono>{`$ ${a.command}`}</Mono>}
      {a.images?.map((id) => (
        <button key={id} type="button" onClick={() => setZoom(id)} className="w-fit overflow-hidden rounded-md border">
          <AuthImage base={base} url={artifactUrl(base, id)} alt="Screenshot" className="max-h-56 w-auto" />
        </button>
      ))}
      {a.kind === "plan" && a.items && (
        <ul className="grid gap-1">
          {a.items.map((it, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className={cn("mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border text-[9px]", it.completed && "border-success bg-success text-white")}>
                {it.completed ? "✓" : ""}
              </span>
              <span className={cn(it.completed && "text-muted-foreground line-through")}>{it.text}</span>
            </li>
          ))}
        </ul>
      )}
      {a.kind === "file_change" && a.changes && (
        <ul className="grid gap-0.5 font-mono text-[11.5px]">
          {a.changes.map((c) => (
            <li key={c.path} className="flex gap-2">
              <span className="w-14 shrink-0 text-muted-foreground">{c.kind}</span>
              <span className="break-all">{c.path}</span>
            </li>
          ))}
        </ul>
      )}
      {a.text && a.tool !== "screenshot" && (
        <Mono className={a.kind === "reasoning" ? "italic" : undefined}>{a.text + (a.truncated ? "\n… (truncated)" : "")}</Mono>
      )}
      {a.exitCode !== undefined && a.kind === "command" && (
        <span className={cn("w-fit rounded px-1.5 py-0.5 font-mono text-[10.5px]", a.exitCode === 0 ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
          exit {a.exitCode}
        </span>
      )}
      {a.error && <p className="text-danger">{a.error}</p>}
      <Dialog open={!!zoom} onOpenChange={(o) => !o && setZoom(null)}>
        <DialogContent className="max-h-[92vh] max-w-[92vw] overflow-hidden p-2">
          <DialogTitle className="sr-only">Screenshot</DialogTitle>
          {zoom && <AuthImage base={base} url={artifactUrl(base, zoom)} alt="Screenshot" className="max-h-[88vh] max-w-full object-contain" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ActivityRow({ a, base, defaultOpen = false }: { a: Activity; base: string; defaultOpen?: boolean }) {
  const sessions = useChat().sessions;
  const [open, setOpen] = useState(defaultOpen);
  const Icon = activityIcon(a);
  const notice = a.kind === "notice";
  const meta = a.kind === "tool" ? a.tool : a.kind === "command" ? "shell" : a.kind === "reasoning" || notice ? "" : a.kind.replace("_", " ");
  const took = a.status === "running" || notice ? "" : duration(a.startedAt, a.updatedAt);
  const metaText = [meta, took && took !== "0s" ? took : ""].filter(Boolean).join(" · ");
  return (
    <div id={`act-${a.id}`} className={cn("rounded-lg", open && "bg-panel")}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[13px] hover:bg-panel",
          notice ? "text-warning" : "text-muted-foreground",
        )}
      >
        <span className="flex w-3.5 justify-center">
          <StepStatus a={a} />
        </span>
        <Icon className="size-3.5 shrink-0" />
        <span className={cn("min-w-0 flex-1 truncate", !notice && "text-foreground/90", a.kind === "reasoning" && "italic text-muted-foreground")}>
          {collabStepTitle(a, sessions) ?? a.title}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground/80">{metaText}</span>
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-90")} />
      </button>
      {open && <Details a={a} base={base} />}
    </div>
  );
}

export function ActivityGroup({ activities, base }: { activities: Activity[]; base: string }) {
  const sessions = useChat().sessions;
  const [open, setOpen] = useState(false);
  const latest = activities[activities.length - 1];
  const failed = activities.filter((a) => a.status === "failed" && a.kind !== "notice").length;
  const took = duration(activities[0].startedAt, latest.updatedAt);
  return (
    <div className="rounded-lg border bg-background">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-muted-foreground hover:bg-panel"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <span className="font-medium text-foreground/85">{activities.length} steps</span>
        {took && <span>· {took}</span>}
        {failed > 0 && <span className="text-danger">· {failed} failed</span>}
        {!open && (
          <span className="ml-1 min-w-0 flex-1 truncate text-right text-[12px]">
            {latest.status === "running" ? "Now: " : "Last: "}
            {collabStepTitle(latest, sessions) ?? latest.title}
          </span>
        )}
      </button>
      {open && (
        <div className="grid gap-0.5 border-t px-1 py-1">
          {activities.map((a) => (
            <ActivityRow key={a.id} a={a} base={base} />
          ))}
        </div>
      )}
    </div>
  );
}
