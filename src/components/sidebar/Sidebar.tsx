import { useQuery } from "@tanstack/react-query";
import {
  Archive, ArchiveRestore, AtSign, ChevronRight, Circle, CircleDot, Laptop, Monitor, MonitorX, MoreHorizontal, Pencil, Pin, PinOff, Plus, Settings, Share2, SquarePen, Star, Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { closeDesktop, fetchArchived, seedDesktop, sessionDesktops, supports } from "@/api/client";
import type { Session } from "@/api/types";
import { StatusIcon, WaitingIcon } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Kbd } from "@/components/ui/kbd";
import { MOD } from "@/lib/platform";
import { chat, useChat } from "@/hooks/useChat";
import { useDesktops, useHealth, useQueue } from "@/hooks/useMachine";
import { desktopMark, desktopOf, seedErrorText } from "@/lib/desktops";
import { imeGuard } from "@/lib/ime";
import { cn, shortAgo } from "@/lib/utils";
import { HandleDialog } from "./HandleDialog";
import { fallbackAddress, RouteChip, RouteContextItems, useReachable } from "@/components/MachineRoute";
import { addressLabel, currentAddress } from "@/lib/machines";
import { baseUrl, needsPairing, useApp, type Machine } from "@/store/app";
import { useComposer } from "@/store/composer";

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
  if (!admin) return <Item disabled>Update office mobd to manage sessions</Item>;
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

function SessionRow({ session, active, admin, desktops, hasDesktop, position, onOpen, onAction }: {
  session: Session;
  active: boolean;
  admin: boolean;
  desktops: boolean;
  hasDesktop: boolean | "asleep";
  position?: number;
  onOpen: () => void;
  onAction: (a: Action) => void;
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
    if (next && next !== session.title) void chat.patchSession(session.id, { title: next });
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
        aria-label="Session title"
        className="mx-1 h-7 w-[calc(100%-8px)] rounded-md border border-accent bg-background px-2 text-[13px] outline-none"
      />
    );
  }
  const status = session.activeTaskId ? session.status : session.status === "failed" ? "failed" : null;
  const DesktopIcon = hasDesktop === "asleep" ? Circle : hasDesktop ? CircleDot : null;
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
            "group relative flex h-8 cursor-default items-center gap-2 rounded-md pl-2.5 pr-1.5 text-[13px] outline-none",
            active ? "bg-foreground/[0.07] font-medium text-foreground" : "text-foreground/80 hover:bg-foreground/[0.04]",
          )}
        >
          {desktops && DesktopIcon && <DesktopIcon className={cn("size-2.5 shrink-0", hasDesktop === "asleep" ? "text-muted-foreground" : "fill-success text-success")} />}
          {session.pinned && <Star className="size-3 shrink-0 fill-warning text-warning" />}
          <span className="min-w-0 flex-1 truncate">{session.title}</span>
          {session.handle && <span className="shrink-0 rounded bg-accent-soft px-1 font-mono text-[11px] font-normal text-accent">@{session.handle}</span>}
          <span className="flex w-7 shrink-0 justify-end group-hover:hidden group-focus-within:hidden">
            {session.waiting ? <WaitingIcon /> : status ? <StatusIcon status={status} position={position} /> : <span className="text-[11px] text-muted-foreground">{shortAgo(session.updatedAt)}</span>}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Session actions"
                onClick={(e) => e.stopPropagation()}
                className="hidden size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex group-focus-within:flex data-[state=open]:flex"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
              <SessionActions session={session} admin={admin} desktops={desktops} hasDesktop={!!hasDesktop} collab={chat.collab} onAction={act} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SessionActions session={session} admin={admin} desktops={desktops} hasDesktop={!!hasDesktop} collab={chat.collab} onAction={act} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ArchivedGroup({ base, admin, desktops, desktopsData, onAction }: {
  base: string;
  admin: boolean;
  desktops: boolean;
  desktopsData: ReturnType<typeof useDesktops>["data"];
  onAction: (s: Session, a: Action) => void;
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
    <div className="mt-1">
      <button type="button" onClick={() => setOpen(!open)} className="flex h-7 w-full items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} /> Archived
      </button>
      {open && (data?.length ? data.map((s) => {
        const mark = desktopMark(desktopOf(desktopsData, s.id));
        return (
          <SessionRow key={s.id} session={s} active={chatState.sessionId === s.id} admin={admin} desktops={desktops}
            hasDesktop={mark === "running" ? true : mark === "asleep" ? "asleep" : false}
            onOpen={() => void chat.open(s.id)} onAction={(a) => onAction(s, a)} />
        );
      }) : <p className="px-7 py-1 text-xs text-muted-foreground/70">Nothing archived</p>)}
    </div>
  );
}

function MachineGroup({ machine, active, onHandleAction }: { machine: Machine; active: boolean; onHandleAction: (s: Session) => void }) {
  const chatState = useChat();
  const { selectMachine, selectRoute, collapsed, set, openSettings } = useApp();
  const unpaired = needsPairing(machine);
  const reachable = useReachable(machine);
  const route = currentAddress(machine);
  const other = fallbackAddress(machine, reachable);
  const base = baseUrl(machine);
  const { data: health, isError } = useHealth(machine);
  const admin = supports(health, "sessionAdmin");
  const desktops = sessionDesktops(health);
  const desktopsData = useDesktops(base, active && desktops);
  const { data: queue } = useQueue(base, active && supports(health, "queue"));
  const positionOf = (sessionId: string) => queue?.queued.find((t) => t.sessionId === sessionId)?.queuePosition;
  const [confirm, setConfirm] = useState<{ session: Session; action: "archive" | "delete" | "closeDesktop" } | null>(null);
  const isCollapsed = !!collapsed[machine.id] && active;
  const checksBad = health && Object.values(health.checks ?? {}).some((c) => !c.ok && !c.unknown);
  const dot = unpaired ? "bg-warning" : isError ? "bg-danger" : !health ? "bg-muted-foreground/30" : checksBad ? "bg-warning" : "bg-success";

  const onAction = async (s: Session, a: Action) => {
    if (a === "handle") {
      onHandleAction(s);
      return;
    }
    if (a === "pin") void chat.patchSession(s.id, { pinned: !s.pinned });
    else if (a === "archive") setConfirm({ session: s, action: "archive" });
    else if (a === "unarchive") void chat.patchSession(s.id, { archived: false });
    else if (a === "delete") setConfirm({ session: s, action: "delete" });
    else if (a === "closeDesktop") setConfirm({ session: s, action: "closeDesktop" });
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
    if (action === "archive") void chat.patchSession(s.id, { archived: true });
    else if (action === "delete") void chat.deleteSession(s.id);
    else if (action === "closeDesktop") {
      try {
        await closeDesktop(base, s.id);
        toast.success("Desktop closed");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    }
  };

  return (
    <div className="mb-2">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground">
            <button
              type="button"
              onClick={() => (active ? set({ collapsed: { ...collapsed, [machine.id]: !collapsed[machine.id] } }) : selectMachine(machine.id))}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              {machine.local ? <Laptop className="size-3.5 shrink-0" aria-label="This computer" /> : <Monitor className="size-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate" title={machine.local ? "This computer" : undefined}>{machine.name}</span>
              {unpaired && !other && <span className="text-[10.5px] font-normal text-warning">Needs pairing</span>}
            </button>
            <RouteChip machine={machine} />
            <span className={cn("size-1.5 shrink-0 rounded-full", dot)} title={reachable === false ? "Not reachable" : undefined} />
            {active && <ChevronRight className={cn("size-3 shrink-0 transition-transform", !isCollapsed && "rotate-90")} />}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <RouteContextItems machine={machine} />
          {machine.addresses.length > 1 && <ContextMenuSeparator />}
          <ContextMenuItem onSelect={() => openSettings("machines", machine.id)}><Settings /> Machine settings…</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {route && other && (
        // The address in use fails and there is another: offer it, never switch by itself.
        <p className="px-7 text-[11px] text-muted-foreground/80">
          {addressLabel(machine, route)} {unpaired ? "needs pairing" : "not reachable"} ·{" "}
          <button type="button" className="font-medium text-foreground hover:underline"
            onClick={() => { selectRoute(machine.id, other.id); selectMachine(machine.id); }}>
            Use {addressLabel(machine, other)}
          </button>
        </p>
      )}
      {active && unpaired && !other && (
        <button type="button" onClick={() => useApp.getState().openAdd(machine.id)}
          className="px-7 text-left text-[11px] text-muted-foreground/80 hover:text-foreground">
          Pair again…
        </button>
      )}
      {active && !isCollapsed && !unpaired && (
        <div className="mt-0.5 grid grid-cols-[minmax(0,1fr)] gap-px">
          {chatState.loading && !chatState.sessions.length && (
            <div className="grid gap-1.5 px-2.5 py-1">
              {[70, 55, 80].map((w) => <div key={w} className="h-3.5 animate-pulse rounded bg-muted" style={{ width: `${w}%` }} />)}
            </div>
          )}
          {chatState.sessions.map((s) => {
            const mark = desktopMark(desktopOf(desktopsData.data, s.id));
            return (
              <SessionRow key={s.id} session={s} active={chatState.sessionId === s.id} admin={admin} desktops={desktops}
                hasDesktop={mark === "running" ? true : mark === "asleep" ? "asleep" : false}
                position={positionOf(s.id)}
                onOpen={() => void chat.open(s.id)} onAction={(a) => onAction(s, a)} />
            );
          })}
          {chatState.ready && !chatState.sessions.length && (
            <p className="px-2.5 py-1 text-xs text-muted-foreground/70">No conversations yet</p>
          )}
          <ArchivedGroup base={base} admin={admin} desktops={desktops} desktopsData={desktopsData.data} onAction={onAction} />
        </div>
      )}
      {!active && <p className="px-7 text-[11px] text-muted-foreground/60">Select to show sessions</p>}
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="w-[400px] p-5" showClose={false}>
          <DialogTitle>
            {confirm?.action === "delete" && "Delete conversation?"}
            {confirm?.action === "archive" && "Archive conversation?"}
            {confirm?.action === "closeDesktop" && "Close desktop?"}
          </DialogTitle>
          <DialogDescription className="mt-1.5">
            {confirm?.action === "delete" && (
              <>"{confirm.session.title}" and its screenshots are removed from the office computer. {desktops && "Its desktop closes; open windows are lost. "}This cannot be undone.</>
            )}
            {confirm?.action === "archive" && (
              <>"{confirm.session.title}" moves to Archived. {desktops && "Its desktop closes; open windows are lost. "}Files and screenshots stay on the office computer.</>
            )}
            {confirm?.action === "closeDesktop" && (
              <>The running turn will be stopped and open windows closed. Files and browser logins are kept.</>
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

export function Sidebar() {
  const [handleDialog, setHandleDialog] = useState<Session | null>(null);
  const { machines, activeMachineId, openSettings } = useApp();
  const chatState = useChat();
  const focus = useComposer((s) => s.focus);
  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r bg-sidebar">
      <div className="px-2 pb-2 pt-1">
        <Button
          variant="secondary"
          className="w-full justify-start gap-2 bg-background/60"
          disabled={!chatState.ready || chatState.submitting}
          onClick={() => {
            chat.newChat();
            focus();
          }}
        >
          <SquarePen className="size-4" />
          New chat
          <span className="ml-auto flex gap-0.5"><Kbd>{MOD}</Kbd><Kbd>N</Kbd></span>
        </Button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Sessions">
        {machines.map((m) => <MachineGroup key={m.id} machine={m} active={m.id === activeMachineId} onHandleAction={setHandleDialog} />)}
      </nav>
      <HandleDialog session={handleDialog} onClose={() => setHandleDialog(null)} />
      <div className="flex gap-1 border-t px-2 py-2">
        <Button variant="ghost" size="sm" className="flex-1 justify-start" onClick={() => openSettings("machines", null)}>
          <Settings className="size-3.5" /> Settings
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Add a computer" onClick={() => useApp.getState().openAdd()}>
          <Plus />
        </Button>
      </div>
    </aside>
  );
}
