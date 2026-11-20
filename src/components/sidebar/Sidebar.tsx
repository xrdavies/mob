import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive, ArchiveRestore, AtSign, ChevronRight, Laptop, Monitor, MonitorX, MoreHorizontal, PanelLeft, Pencil, Pin, PinOff, Plus, Search, Server,
  Settings, Share2, SquarePen, Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { closeDesktop, deleteSessionAt, fetchArchived, patchSessionAt, seedDesktop, sessionDesktops, supports } from "@/api/client";
import type { Session } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Spinner, WaitingIcon } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Kbd } from "@/components/ui/kbd";
import { isMac, MOD, shortcut } from "@/lib/platform";
import { chat, useChat } from "@/hooks/useChat";
import { useComputerSessions, useNeedsYou } from "@/hooks/useComputers";
import { useDesktops, useHealth, useQueue } from "@/hooks/useMachine";
import { newChatOn, openSession } from "@/hooks/navigate";
import { sessionLine, visibleSessions } from "@/lib/computers";
import { desktopMark, desktopOf, seedErrorText } from "@/lib/desktops";
import { imeGuard } from "@/lib/ime";
import { isTauri } from "@/lib/tauri";
import { cn, shortAgo } from "@/lib/utils";
import { HandleDialog } from "./HandleDialog";
import { fallbackAddress, RouteChip, RouteContextItems, useReachable } from "@/components/MachineRoute";
import { addressLabel, currentAddress, isLocal } from "@/lib/machines";
import { baseUrl, needsPairing, useApp, type Machine } from "@/store/app";


type Action = "rename" | "pin" | "archive" | "unarchive" | "delete" | "closeDesktop" | "seed" | "handle";

function SessionActions({ session, admin, desktops, hasDesktop, collab, onAction, Item, Separator }: {
  session: Session;
  admin: boolean;
  desktops: boolean;
  hasDesktop: boolean;
  collab: boolean;
  onAction: (a: Action) => void;
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator;
}) {
  if (!admin) return <Item disabled>Update mobd on this computer to manage conversations</Item>;
  const busy = !!session.activeTaskId;
  return (
    <>
      <Item onSelect={() => onAction("rename")}><Pencil /> Rename</Item>
      {collab && <Item onSelect={() => onAction("handle")}><AtSign /> {session.handle ? "Change handle…" : "Set handle…"}</Item>}
      {!session.archived && (
        <Item onSelect={() => onAction("pin")}>{session.pinned ? <><PinOff /> Unpin</> : <><Pin /> Pin</>}</Item>
      )}
      {desktops && hasDesktop && (
        <Item onSelect={() => onAction("closeDesktop")}><MonitorX /> Close desktop…</Item>
      )}
      {desktops && hasDesktop && (
        <Item onSelect={() => onAction("seed")}><Share2 /> Use this browser profile for new conversations</Item>
      )}
      {(desktops && hasDesktop) && <Separator />}
      {session.archived
        ? <Item onSelect={() => onAction("unarchive")}><ArchiveRestore /> Unarchive</Item>
        : <Item onSelect={() => onAction("archive")}><Archive /> Archive…</Item>}
      <Separator />
      <Item danger disabled={busy} onSelect={() => onAction("delete")}><Trash2 /> Delete…</Item>
    </>
  );
}

/** The line under a conversation's title: its state in the status vocabulary, and @handle. */
function StatusLine({ session, position }: { session: Session; position?: number }) {
  const line = sessionLine(session, position);
  return (
    <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-muted-foreground">
      {line.tone === "needs" && <span className="flex items-center gap-1 font-medium text-warning"><WaitingIcon className="size-3" />{line.text}</span>}
      {line.tone === "working" && <span className="flex items-center gap-1 text-accent"><Spinner className="size-2.5 border-[1.5px]" />{line.text}</span>}
      {line.tone === "queued" && <span className="flex items-center gap-1"><span className="size-2.5 rounded-full border-[1.5px] border-dashed border-muted-foreground/70" />{line.text}</span>}
      {line.tone === "failed" && <span className="font-medium text-danger">✕ {line.text}</span>}
      {line.tone === "done" && <span><span className="text-success">✓</span> {line.text}{session.updatedAt && ` · ${shortAgo(session.updatedAt)}`}</span>}
      {session.handle && <span className="truncate">· @{session.handle}</span>}
    </span>
  );
}

function SessionRow({ session, active, admin, desktops, hasDesktop, position, onOpen, onAction, onRename }: {
  session: Session;
  active: boolean;
  admin: boolean;
  desktops: boolean;
  hasDesktop: boolean | "asleep";
  position?: number;
  onOpen: () => void;
  onAction: (a: Action) => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [ime] = useState(imeGuard);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);
  const act = (a: Action) => (a === "rename" ? (setTitle(session.title), setEditing(true)) : onAction(a));
  const commit = () => {
    setEditing(false);
    const next = title.trim();
    if (next && next !== session.title) onRename(next);
  };
  if (editing) {
    return (
      <input
        ref={field}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onCompositionStart={ime.start}
        onCompositionEnd={ime.end}
        onKeyDown={(e) => {
          // Enter and Escape that end Pinyin or another input method belong to it.
          if (ime.owns(e.nativeEvent)) return;
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        aria-label="Conversation title"
        className="mx-1 my-1 h-8 w-[calc(100%-8px)] rounded-md border border-accent bg-background px-2 text-[13px] outline-none"
      />
    );
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          aria-current={active ? "true" : undefined}
          onClick={onOpen}
          onKeyDown={(e) => e.key === "Enter" && onOpen()}
          onDoubleClick={() => admin && act("rename")}
          title={session.title}
          className={cn(
            "group relative flex cursor-default items-start gap-2 rounded-md py-1.5 pl-2 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            active ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]",
          )}
        >
          <AgentAvatar runner={session.runner} className="mt-px" />
          <span className="grid min-w-0 flex-1">
            <span className={cn("flex items-center gap-1 truncate text-[13px] leading-[18px]", active ? "font-medium text-foreground" : "text-foreground/85")}>
              {session.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
              <span className="truncate">{session.title}</span>
            </span>
            <StatusLine session={session} position={position} />
          </span>
          {desktops && hasDesktop && (
            <span title={hasDesktop === "asleep" ? "Desktop asleep" : "Desktop running"}
              className={cn("mt-1.5 size-1.5 shrink-0 rounded-full group-hover:hidden", hasDesktop === "asleep" ? "bg-muted-foreground/40" : "bg-success")} />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Conversation actions"
                onClick={(e) => e.stopPropagation()}
                className="absolute right-1 top-1.5 hidden size-6 items-center justify-center rounded bg-sidebar text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex group-focus-within:flex data-[state=open]:flex"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
              <SessionActions session={session} admin={admin} desktops={desktops} hasDesktop={!!hasDesktop} collab={active && chat.collab} onAction={act} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SessionActions session={session} admin={admin} desktops={desktops} hasDesktop={!!hasDesktop} collab={active && chat.collab} onAction={act} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ArchivedGroup({ base, admin, onAction, onRename }: {
  base: string;
  admin: boolean;
  onAction: (s: Session, a: Action) => void;
  onRename: (s: Session, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const chatState = useChat();
  const { data } = useQuery({
    queryKey: ["archived", base, chatState.sessions.length],
    queryFn: () => fetchArchived(base),
    enabled: open && admin,
  });
  if (!admin) return null;
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} /> Archived
      </button>
      {open && (data?.length ? data.map((s) => (
        <SessionRow key={s.id} session={s} active={chatState.sessionId === s.id} admin={admin} desktops={false} hasDesktop={false}
          onOpen={() => void chat.open(s.id)} onAction={(a) => onAction(s, a)} onRename={(t) => onRename(s, t)} />
      )) : <p className="px-7 py-1 text-xs text-muted-foreground/70">Nothing archived</p>)}
    </div>
  );
}

const ComputerIcon = ({ machine, className }: { machine: Machine; className?: string }) => {
  const Icon = isLocal(machine) ? Laptop : /linux/i.test(machine.name) ? Server : Monitor;
  return <Icon className={className} aria-label={isLocal(machine) ? "This computer" : undefined} />;
};

function ComputerGroup({ machine, onHandleAction }: { machine: Machine; onHandleAction: (s: Session) => void }) {
  const qc = useQueryClient();
  const chatState = useChat();
  const { activeMachineId, selectRoute, selectMachine, collapsed, set, openSettings, perComputer, view } = useApp();
  const active = machine.id === activeMachineId;
  const unpaired = needsPairing(machine);
  const reachable = useReachable(machine);
  const route = currentAddress(machine);
  const other = fallbackAddress(machine, reachable);
  const base = baseUrl(machine);
  const { data: health, isError } = useHealth(machine);
  const admin = supports(health, "sessionAdmin");
  const desktops = active && sessionDesktops(health);
  const desktopsData = useDesktops(base, desktops);
  const { data: queue } = useQueue(base, active && supports(health, "queue"));
  const positionOf = (sessionId: string) => queue?.queued.find((t) => t.sessionId === sessionId)?.queuePosition;
  const { sessions, loading } = useComputerSessions(machine);
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState<{ session: Session; action: "archive" | "delete" | "closeDesktop" } | null>(null);
  const offline = isError || reachable === false;
  // Offline computers stay listed, folded, until the user unfolds them.
  const isCollapsed = collapsed[machine.id] ?? offline;
  const checksBad = health && Object.values(health.checks ?? {}).some((c) => !c.ok && !c.unknown);
  const dot = unpaired ? "bg-warning" : offline ? "bg-muted-foreground/40" : !health ? "bg-muted-foreground/25" : checksBad ? "bg-warning" : "bg-success";
  const waiting = sessions.filter((s) => s.waiting).length;
  const ordered = [...sessions.filter((s) => s.pinned), ...sessions.filter((s) => !s.pinned)];
  const openId = active && view === "chat" ? chatState.sessionId : null;
  const { shown, hidden } = visibleSessions(ordered, perComputer, expanded, openId);

  // The open computer's conversations change through Chat; another computer's through its API and stream.
  const patch = (s: Session, p: { title?: string; pinned?: boolean; archived?: boolean }) => {
    if (active) return void chat.patchSession(s.id, p);
    patchSessionAt(base, s.id, p).catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  };
  const remove = (s: Session) => {
    if (active) return void chat.deleteSession(s.id);
    deleteSessionAt(base, s.id)
      .then(() => qc.setQueryData<Session[]>(["sessions", base], (list) => (list ?? []).filter((x) => x.id !== s.id)))
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  };

  const onAction = async (s: Session, a: Action) => {
    if (a === "handle") return onHandleAction(s);
    if (a === "pin") patch(s, { pinned: !s.pinned });
    else if (a === "archive" || a === "delete" || a === "closeDesktop") setConfirm({ session: s, action: a });
    else if (a === "unarchive") patch(s, { archived: false });
    else if (a === "seed") {
      try {
        await seedDesktop(base, s.id);
        toast.success("New conversations start with this conversation's browser logins.");
      } catch (err) {
        toast.error(seedErrorText(err));
      }
    }
  };

  const doConfirm = async () => {
    if (!confirm) return;
    const { session: s, action } = confirm;
    setConfirm(null);
    if (action === "archive") patch(s, { archived: true });
    else if (action === "delete") remove(s);
    else if (action === "closeDesktop") {
      try {
        await closeDesktop(base, s.id);
        toast.success("Desktop closed");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const toggle = () => set({ collapsed: { ...collapsed, [machine.id]: !isCollapsed } });

  return (
    <div className="mb-1.5">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group/computer flex h-8 w-full items-center gap-1.5 rounded-md pl-1 pr-1 text-[13px] font-medium hover:bg-foreground/[0.04]">
            <button type="button" onClick={toggle} aria-expanded={!isCollapsed} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
              <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !isCollapsed && "rotate-90")} />
              <ComputerIcon machine={machine} className="size-3.5 shrink-0 text-muted-foreground" />
              <span className={cn("min-w-0 truncate", offline && "text-muted-foreground")}>{machine.name}</span>
              <span className={cn("size-1.5 shrink-0 rounded-full", dot)} title={unpaired ? "Needs pairing" : offline ? "Offline" : checksBad ? "Needs attention" : "Online"} />
              <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 text-[11px] font-normal text-muted-foreground group-hover/computer:hidden">
                {unpaired ? "Needs pairing" : offline ? "Offline" : waiting > 0 && <><span className="tabular-nums text-warning">{waiting}</span><WaitingIcon className="size-3" /></>}
              </span>
            </button>
            <RouteChip machine={machine} />
            {!unpaired && (
              <IconButton label={`New chat on ${machine.name}`} className="hidden size-6 group-hover/computer:inline-flex" onClick={() => newChatOn(machine.id)}>
                <Plus />
              </IconButton>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {!unpaired && <ContextMenuItem onSelect={() => newChatOn(machine.id)}><SquarePen /> New chat</ContextMenuItem>}
          <RouteContextItems machine={machine} />
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => openSettings("machines", machine.id)}><Settings /> Computer settings…</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {route && other && (
        // The address in use fails and there is another: offer it, never switch by itself.
        <p className="pl-7 text-[11px] text-muted-foreground">
          {addressLabel(machine, route)} {unpaired ? "needs pairing" : "not reachable"} ·{" "}
          <button type="button" className="font-medium text-foreground hover:underline"
            onClick={() => { selectRoute(machine.id, other.id); selectMachine(machine.id); }}>
            Use {addressLabel(machine, other)}
          </button>
        </p>
      )}
      {!isCollapsed && unpaired && !other && (
        <button type="button" onClick={() => useApp.getState().openAdd(machine.id)}
          className="pl-7 text-left text-[11.5px] font-medium text-accent hover:underline">
          Pair again…
        </button>
      )}
      {!isCollapsed && !unpaired && (
        <div className="mt-px grid grid-cols-[minmax(0,1fr)] gap-px pl-2.5">
          {loading && (
            <div className="grid gap-2 px-2 py-1.5">
              {[70, 55, 80].map((w) => <div key={w} className="h-3.5 animate-pulse rounded bg-muted" style={{ width: `${w}%` }} />)}
            </div>
          )}
          {shown.map((s) => {
            const mark = desktops ? desktopMark(desktopOf(desktopsData.data, s.id)) : null;
            return (
              <SessionRow key={s.id} session={s} active={openId === s.id} admin={admin} desktops={desktops}
                hasDesktop={mark === "running" ? true : mark === "asleep" ? "asleep" : false}
                position={active ? positionOf(s.id) : undefined}
                onOpen={() => openSession(machine.id, s.id)} onAction={(a) => onAction(s, a)} onRename={(t) => patch(s, { title: t })} />
            );
          })}
          {!loading && !sessions.length && !offline && (
            <button type="button" onClick={() => newChatOn(machine.id)} className="px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground">
              No conversations yet
            </button>
          )}
          {(hidden > 0 || expanded) && (
            <button type="button" onClick={() => setExpanded(!expanded)}
              className="h-7 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground">
              {expanded ? "Show less" : `Show ${hidden} more`}
            </button>
          )}
          {expanded && active && <ArchivedGroup base={base} admin={admin} onAction={onAction} onRename={(s, t) => patch(s, { title: t })} />}
        </div>
      )}
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="w-[400px] p-5" showClose={false}>
          <DialogTitle>
            {confirm?.action === "delete" && "Delete conversation?"}
            {confirm?.action === "archive" && "Archive conversation?"}
            {confirm?.action === "closeDesktop" && "Close desktop?"}
          </DialogTitle>
          <DialogDescription className="mt-1.5">
            {confirm?.action === "delete" && (
              <>"{confirm.session.title}" and its screenshots are removed from {machine.name}. {desktops && "Its desktop closes; open windows are lost. "}This cannot be undone.</>
            )}
            {confirm?.action === "archive" && (
              <>"{confirm.session.title}" moves to Archived. {desktops && "Its desktop closes; open windows are lost. "}Files and screenshots stay on {machine.name}.</>
            )}
            {confirm?.action === "closeDesktop" && (
              <>The running turn stops and open windows close. Files and browser logins are kept.</>
            )}
          </DialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant={confirm?.action === "delete" ? "danger" : "default"} onClick={doConfirm}>
              {confirm?.action === "delete" && "Delete"}
              {confirm?.action === "archive" && "Archive"}
              {confirm?.action === "closeDesktop" && "Close desktop"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NeedsYouRow() {
  const waiting = useNeedsYou();
  const { view, set } = useApp();
  return (
    <button
      type="button"
      aria-current={view === "needs" ? "page" : undefined}
      onClick={() => set({ view: "needs" })}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
        view === "needs" ? "bg-foreground/[0.07] font-medium" : "hover:bg-foreground/[0.04]",
      )}
    >
      <WaitingIcon className={cn(!waiting.length && "opacity-40 grayscale")} />
      Needs you
      {waiting.length > 0 && (
        <span className="ml-auto rounded-full bg-warning px-1.5 text-[11px] font-semibold tabular-nums leading-[18px] text-white">{waiting.length}</span>
      )}
    </button>
  );
}

export function Sidebar() {
  const [handleDialog, setHandleDialog] = useState<Session | null>(null);
  const { machines, openSettings, set, activeMachineId } = useApp();
  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col border-r bg-sidebar">
      <div data-tauri-drag-region className={cn("flex h-12 shrink-0 items-center gap-1.5 pr-2", isTauri && isMac ? "pl-[78px]" : "pl-3")}>
        <img src="/logo.svg" alt="" draggable={false} data-tauri-drag-region className="size-6 shrink-0" />
        <span data-tauri-drag-region className="flex-1 text-[14px] font-semibold tracking-tight">Mob</span>
        <IconButton label="Hide sidebar" shortcut={shortcut("B")} onClick={() => set({ sidebarOpen: false })}><PanelLeft /></IconButton>
        <IconButton label="New chat" shortcut={shortcut("N")} disabled={!activeMachineId} onClick={() => activeMachineId && newChatOn(activeMachineId)}>
          <SquarePen />
        </IconButton>
      </div>
      <div className="grid gap-0.5 px-2 pb-2">
        <button
          type="button"
          onClick={() => set({ paletteOpen: true })}
          className="mb-1 flex h-8 items-center gap-2 rounded-md border bg-background/70 px-2.5 text-[13px] text-muted-foreground shadow-xs hover:bg-background"
        >
          <Search className="size-3.5" /> Search or ask an agent…
          <span className="ml-auto flex gap-0.5"><Kbd>{MOD}</Kbd><Kbd>K</Kbd></span>
        </button>
        <NeedsYouRow />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Computers">
        <div className="flex h-7 items-center pl-2 pr-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span className="flex-1">Computers</span>
          <IconButton label="Add a computer" className="size-6" onClick={() => useApp.getState().openAdd()}><Plus /></IconButton>
        </div>
        {machines.map((m) => <ComputerGroup key={m.id} machine={m} onHandleAction={setHandleDialog} />)}
      </nav>
      <HandleDialog session={handleDialog} onClose={() => setHandleDialog(null)} />
      <div className="border-t px-2 py-2">
        <Button variant="ghost" size="sm" className="w-full justify-start text-[13px] font-normal" onClick={() => openSettings("machines", null)}>
          <Settings className="size-3.5" /> Settings
          <span className="ml-auto text-[11px] text-muted-foreground">{shortcut(",")}</span>
        </Button>
      </div>
    </aside>
  );
}
