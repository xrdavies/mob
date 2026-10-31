import { Folder, Monitor, Moon, PanelLeft, RefreshCw, Search, Settings, Sun } from "lucide-react";
import type { Health, Queue } from "@/api/types";
import { ChecksList } from "@/components/settings/SettingsDialog";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isMac, MOD, shortcut } from "@/lib/platform";
import { baseUrl, needsPairing, useApp, type Machine } from "@/store/app";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function HealthChip({ machine, health, error, queue, refetch }: {
  machine: Machine;
  health?: Health;
  error: boolean;
  queue?: Queue;
  refetch: () => void;
}) {
  const openSettings = useApp((s) => s.openSettings);
  const unpaired = needsPairing(machine);
  const checks = Object.values(health?.checks ?? {});
  const failing = checks.filter((c) => !c.ok && !c.unknown).length;
  const state = unpaired ? "needs pairing" : error ? "offline" : !health ? "checking" : failing ? `${failing} issue${failing > 1 ? "s" : ""}` : "ready";
  const dot = unpaired ? "bg-warning" : error ? "bg-danger" : !health ? "bg-muted-foreground/40" : failing ? "bg-warning" : "bg-success";
  const waiting = queue?.queued.length ?? 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-7 items-center gap-2 rounded-md px-2 text-xs hover:bg-muted">
          <span className={cn("size-2 rounded-full", dot)} />
          <span className="font-medium">{machine.name}</span>
          <span className="text-muted-foreground">{state}</span>
          {waiting > 0 && <span className="rounded-full bg-muted px-1.5 text-[10.5px] text-muted-foreground">queue {waiting}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <p className="text-[13px] font-semibold">{machine.name}</p>
            <p className="text-[11px] text-muted-foreground">{baseUrl(machine)}{health && ` · API v${health.apiVersion}`}</p>
          </div>
          {!unpaired && <Button variant="ghost" size="icon-sm" aria-label="Recheck" onClick={refetch}><RefreshCw /></Button>}
        </div>
        {unpaired && (
          <div className="grid gap-2">
            <p className="text-xs text-muted-foreground">
              This device needs to be paired again. Run <code className="font-mono">mobd link</code> on the office computer and paste the new link.
            </p>
            <Button size="sm" className="w-fit" onClick={() => openSettings("machines", machine.id)}>Pair again</Button>
          </div>
        )}
        {error && !unpaired && <p className="text-xs text-danger">mobd is unreachable. Check the URL, network/VPN and MOBD_CORS_ORIGINS on the office computer.</p>}
        {health && !health.checks && <p className="text-xs text-muted-foreground">This mobd does not report readiness checks. Update it to API v3.</p>}
        <ChecksList checks={health?.checks} />
      </PopoverContent>
    </Popover>
  );
}

export function TitleBar(props: {
  machine: Machine | null;
  health?: Health;
  healthError: boolean;
  queue?: Queue;
  refetchHealth: () => void;
  dark: boolean;
}) {
  const { sidebarOpen, previewOpen, theme, set, openSettings, togglePreview } = useApp();
  return (
    <header
      data-tauri-drag-region
      className={cn("flex h-11 shrink-0 select-none items-center gap-1 border-b bg-sidebar pr-2", isTauri && isMac ? "pl-[78px]" : "pl-2")}
    >
      <Tooltip content={`Toggle sidebar (${shortcut("B")})`}>
        <Button variant="ghost" size="icon-sm" aria-label="Toggle sidebar" onClick={() => set({ sidebarOpen: !sidebarOpen })}><PanelLeft /></Button>
      </Tooltip>
      <img src="/logo.svg" alt="" draggable={false} data-tauri-drag-region className="ml-1 size-8 shrink-0" />
      <span data-tauri-drag-region className="text-[13px] font-semibold tracking-tight">Mob</span>
      <div data-tauri-drag-region className="flex flex-1 items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => set({ paletteOpen: true })}
          className="flex h-7 w-64 items-center gap-2 rounded-md border bg-background/70 px-2.5 text-xs text-muted-foreground hover:bg-background"
        >
          <Search className="size-3.5" /> Search or run a command
          <span className="ml-auto flex gap-0.5"><Kbd>{MOD}</Kbd><Kbd>K</Kbd></span>
        </button>
        {props.machine && (
          <HealthChip machine={props.machine} health={props.health} error={props.healthError} queue={props.queue} refetch={props.refetchHealth} />
        )}
      </div>
      <Tooltip content={props.dark ? "Light theme" : "Dark theme"}>
        <Button variant="ghost" size="icon-sm" aria-label="Toggle theme" onClick={() => set({ theme: props.dark ? "light" : theme === "light" ? "dark" : "dark" })}>
          {props.dark ? <Sun /> : <Moon />}
        </Button>
      </Tooltip>
      {/* The shared folder belongs to the machine, not to a conversation. */}
      {props.machine && !needsPairing(props.machine) && (
        <Tooltip content="Move files to and from the office computer">
          <Button variant="ghost" size="sm" onClick={() => set({ filesOpen: true })} className="h-7 gap-1.5 px-2.5">
            <Folder className="size-3.5" /> Files
          </Button>
        </Tooltip>
      )}
      {props.machine && (
        <Tooltip content={`${previewOpen ? "Hide" : "Show"} the office desktop (${shortcut("B", true)})`}>
          <Button variant="ghost" size="sm" aria-pressed={previewOpen} onClick={() => togglePreview()}
            className={cn("h-7 gap-1.5 px-2.5", previewOpen && "bg-muted text-foreground")}>
            <Monitor className="size-3.5" /> Desktop
          </Button>
        </Tooltip>
      )}
      <Tooltip content={`Settings (${shortcut(",")})`}>
        <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={() => openSettings()}><Settings /></Button>
      </Tooltip>
    </header>
  );
}
