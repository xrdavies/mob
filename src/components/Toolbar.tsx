import { Archive, Folder, MoreHorizontal, MousePointer2, PanelLeft, PanelRight, Pencil, Pin, PinOff, RefreshCw, Square, Trash2, Usb } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Health, Queue } from "@/api/types";
import { AgentAvatar, runnerLabel } from "@/components/AgentAvatar";
import { ComputerIcon } from "@/components/ComputerIcon";
import { ChecksList } from "@/components/settings/ComputerPage";
import { SyncStatus } from "@/components/timeline/SyncStatus";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { supports } from "@/api/client";
import { chat, useChat } from "@/hooks/useChat";
import { useLocalScreenUse } from "@/hooks/useMachine";
import { imeGuard } from "@/lib/ime";
import { isLocal } from "@/lib/machines";
import { isMac, shortcut } from "@/lib/platform";
import { screenUseText } from "@/lib/screenUse";
import { isTauri } from "@/lib/tauri";
import { active } from "@/lib/usb";
import { cn } from "@/lib/utils";
import { baseUrl, needsPairing, useApp, type Machine } from "@/store/app";
import { useUsb } from "@/store/usb";

/** The computer and its state; opens its readiness checks. */
function ComputerChip({ machine, health, error, queue, refetch }: {
  machine: Machine;
  health?: Health;
  error: boolean;
  queue?: Queue;
  refetch: () => void;
}) {
  const unpaired = needsPairing(machine);
  const checks = Object.values(health?.checks ?? {});
  const failing = checks.filter((c) => !c.ok && !c.unknown).length;
  const state = unpaired ? "Needs pairing" : error ? "Offline" : !health ? "" : failing ? `${failing} issue${failing > 1 ? "s" : ""}` : "";
  const dot = unpaired ? "bg-warning" : error ? "bg-muted-foreground/40" : !health ? "bg-muted-foreground/25" : failing ? "bg-warning" : "bg-success";
  const waiting = queue?.queued.length ?? 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex items-center gap-1 rounded px-1 hover:bg-muted hover:text-foreground">
          <ComputerIcon machine={machine} className="size-3" /> {machine.name}
          <span className={cn("size-1.5 rounded-full", dot)} />
          {state && <span className={cn(failing || unpaired ? "text-warning" : "text-muted-foreground")}>{state}</span>}
          {waiting > 0 && <span className="text-muted-foreground">· {waiting} queued</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <p className="text-[13px] font-semibold">{machine.name}</p>
            <p className="text-[11px] text-muted-foreground">{baseUrl(machine)}{health && ` · API v${health.apiVersion}`}</p>
          </div>
          {!unpaired && <IconButton label="Check again" onClick={refetch}><RefreshCw /></IconButton>}
        </div>
        {unpaired && <Button size="sm" className="w-fit" onClick={() => useApp.getState().openAdd(machine.id)}>Pair again</Button>}
        {error && !unpaired && <p className="text-xs text-danger">mobd is not reachable. Check the address, network or VPN.</p>}
        <ChecksList checks={health?.checks} />
      </PopoverContent>
    </Popover>
  );
}

/** Shown while an agent or another device acts on this computer's screen, so the pointer moving is no surprise. */
function ScreenUsePill() {
  const uses = useLocalScreenUse();
  const local = useApp((s) => s.machines.find(isLocal));
  const activeId = useApp((s) => s.activeMachineId);
  const chatState = useChat();
  if (!uses.length || !local) return null;
  // Conversation titles are known for the open computer only.
  const title = (id?: string) => (activeId === local.id ? chatState.sessions.find((x) => x.id === id)?.title : undefined);
  const agent = uses.find((u) => u.source === "agent");
  return (
    <Tooltip content={screenUseText(uses, title)}>
      <button type="button" role="status" aria-live="polite"
        onClick={() => {
          // Opens the agent's conversation: directly when this computer is open, else on switching to it.
          const app = useApp.getState();
          app.set({ view: "chat" });
          if (activeId === local.id) {
            if (agent?.sessionId) void chat.open(agent.sessionId);
            return;
          }
          if (agent?.sessionId) app.rememberSession(local.id, agent.sessionId);
          app.selectMachine(local.id);
        }}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-mint bg-mint/40 px-2.5 text-xs font-medium text-ink dark:bg-mint/15 dark:text-mint">
        <MousePointer2 className="size-3.5 animate-pulse" />
        {agent ? "Agent is using the screen" : "Screen in use"}
      </button>
    </Tooltip>
  );
}

/** USB devices, with how many of this computer's are shared now. */
function UsbButton({ machine, onClick }: { machine: Machine; onClick: () => void }) {
  const shared = useUsb((s) => Object.values(s.shares).filter((x) => x.machineId === machine.id && active(x.state)).length);
  return (
    <span className="relative">
      <IconButton label={shared ? `${shared} USB device${shared > 1 ? "s" : ""} shared` : "Share a USB device"} onClick={onClick}><Usb /></IconButton>
      {shared > 0 && <span className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-success" />}
    </span>
  );
}

type Confirm = "archive" | "delete" | null;

/**
 * The conversation's title line (docs/desktop-redesign, Toolbar): title; agent, @handle, the agents it
 * works with and the computer; the screen-use pill; side panel toggle; the conversation menu.
 */
export function Toolbar({ machine, health, healthError, queue, refetchHealth }: {
  machine: Machine;
  health?: Health;
  healthError: boolean;
  queue?: Queue;
  refetchHealth: () => void;
}) {
  const { sidebarOpen, previewOpen, set, togglePreview, view } = useApp();
  const chatState = useChat();
  const session = view === "chat" ? chatState.session : null;
  const summary = session && chatState.sessions.find((s) => s.id === session.id);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [ime] = useState(imeGuard);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);
  useEffect(() => setEditing(false), [session?.id]);
  const admin = supports(health, "sessionAdmin");
  const remote = !isLocal(machine) && !needsPairing(machine);
  const runner = session?.runner ?? chatState.currentTask?.runner;
  // The agents this conversation asked or was asked by (agent collaboration).
  const others = session
    ? [...new Set(chatState.requests.map((r) => (r.from === session.id ? r.toName : r.fromName)).filter((n) => n && n !== session.handle))]
    : [];
  const commit = () => {
    setEditing(false);
    const next = title.trim();
    if (session && next && next !== session.title) void chat.patchSession(session.id, { title: next });
  };
  const heading = view === "needs" ? "Needs you" : session?.title ?? (chatState.loading ? "Loading…" : "New chat");

  return (
    <header data-tauri-drag-region
      className={cn("flex h-12 shrink-0 select-none items-center gap-1 border-b px-3", !sidebarOpen && isTauri && isMac && "pl-[78px]")}>
      {!sidebarOpen && (
        <IconButton label="Show sidebar" shortcut={shortcut("B")} onClick={() => set({ sidebarOpen: true })}><PanelLeft /></IconButton>
      )}
      <div data-tauri-drag-region className="grid min-w-0 flex-1 pl-1">
        {editing ? (
          <input ref={field} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={commit}
            onCompositionStart={ime.start} onCompositionEnd={ime.end}
            onKeyDown={(e) => {
              if (ime.owns(e.nativeEvent)) return;
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            aria-label="Conversation title" className="h-6 w-full max-w-[420px] rounded border border-accent bg-background px-1.5 text-[13px] font-semibold outline-none" />
        ) : (
          <h1 data-tauri-drag-region className="flex min-w-0 items-center gap-2 text-[13px] font-semibold leading-5"
            onDoubleClick={() => session && admin && (setTitle(session.title), setEditing(true))}>
            <span className="truncate">{heading}</span>
            {view === "chat" && <SyncStatus />}
          </h1>
        )}
        {view === "chat" && (
          <div className="flex min-w-0 items-center gap-1 text-[11.5px] leading-4 text-muted-foreground">
            {session && (
              <>
                <AgentAvatar runner={runner} size="sm" />
                <span className="truncate">{runnerLabel(runner)}</span>
                {session.handle && <span className="truncate">· @{session.handle}</span>}
                {others.length > 0 && <span className="truncate">with {others.map((o) => `@${o}`).join(", ")}</span>}
                <span>·</span>
              </>
            )}
            <ComputerChip machine={machine} health={health} error={healthError} queue={queue} refetch={refetchHealth} />
          </div>
        )}
      </div>
      <ScreenUsePill />
      {/* The shared folder and USB belong to the computer; not for this one: the user is sitting at it. */}
      {remote && <IconButton label="Files" onClick={() => set({ filesOpen: true })}><Folder /></IconButton>}
      {remote && isTauri && supports(health, "usbRedirection") && <UsbButton machine={machine} onClick={() => set({ usbOpen: true })} />}
      {view === "chat" && (
        <IconButton label={previewOpen ? "Hide side panel" : "Show side panel"} shortcut={shortcut("B", true)} aria-pressed={previewOpen}
          className={cn(previewOpen && "bg-muted text-foreground")} onClick={() => togglePreview()}>
          <PanelRight />
        </IconButton>
      )}
      {session && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Conversation menu"><MoreHorizontal /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!admin} onSelect={() => { setTitle(session.title); setEditing(true); }}><Pencil /> Rename</DropdownMenuItem>
            <DropdownMenuItem disabled={!admin} onSelect={() => void chat.patchSession(session.id, { pinned: !summary?.pinned })}>
              {summary?.pinned ? <><PinOff /> Unpin</> : <><Pin /> Pin</>}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!admin} onSelect={() => setConfirm("archive")}><Archive /> Archive…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => togglePreview()}><PanelRight /> {previewOpen ? "Hide side panel" : "Show side panel"}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!chatState.busy || chatState.cancelling} onSelect={() => void chat.cancel()}><Square /> Stop the agent</DropdownMenuItem>
            <DropdownMenuItem danger disabled={!admin || chatState.busy} onSelect={() => setConfirm("delete")}><Trash2 /> Delete…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="w-[400px] p-5" showClose={false}>
          <DialogTitle>{confirm === "delete" ? "Delete conversation?" : "Archive conversation?"}</DialogTitle>
          <DialogDescription className="mt-1.5">
            {confirm === "delete"
              ? <>"{session?.title}" and its screenshots are removed from {machine.name}. This cannot be undone.</>
              : <>"{session?.title}" moves to Archived. Files and screenshots stay on {machine.name}.</>}
          </DialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant={confirm === "delete" ? "danger" : "default"} onClick={() => {
              if (session && confirm === "delete") void chat.deleteSession(session.id);
              if (session && confirm === "archive") void chat.patchSession(session.id, { archived: true });
              setConfirm(null);
            }}>
              {confirm === "delete" ? "Delete" : "Archive"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );
}
