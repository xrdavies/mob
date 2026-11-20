import { CornerDownLeft, Folder, Laptop, Monitor, Moon, PanelLeft, PanelRight, Plug, Plus, Settings, SquarePen, Sun, Usb } from "lucide-react";
import { useEffect, useState } from "react";
import { AgentAvatar, runnerLabel } from "@/components/AgentAvatar";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { WaitingIcon, StatusIcon } from "@/components/StatusIcon";
import { useAllSessions } from "@/hooks/useComputers";
import { useHealth } from "@/hooks/useMachine";
import { askAgent, newChatOn, openSession } from "@/hooks/navigate";
import { stream, useStream } from "@/lib/stream";
import { isLocal } from "@/lib/machines";
import { MOD } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { needsPairing, useApp } from "@/store/app";

const ASK = "\u0000ask";

/** Every word of the search appears in the item (cmdk's fuzzy match ranks too loosely for titles). */
function match(value: string, search: string, keywords?: string[]): number {
  if (value === ASK) return 1;
  const hay = `${value} ${keywords?.join(" ") ?? ""}`.toLowerCase();
  return search.toLowerCase().split(/\s+/).every((w) => hay.includes(w)) ? 0.5 : 0;
}

/**
 * ⌘K (docs/desktop-redesign D3): one field to find a conversation on any computer, ask an agent on
 * any computer, or run a command. Enter asks the chosen agent on the chosen computer; ⌘1–9 picks
 * the computer and Tab the agent.
 */
export function CommandPalette({ onConnect }: { onConnect: () => void }) {
  const { paletteOpen, machines, activeMachineId, set, openSettings, sidebarOpen, previewOpen } = useApp();
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [runnerPick, setRunnerPick] = useState<string | null>(null);
  const all = useAllSessions();
  const paired = machines.filter((m) => !needsPairing(m));
  const computer = paired.find((m) => m.id === target) ?? paired.find((m) => m.id === activeMachineId) ?? paired[0];
  const { data: health } = useHealth(computer);
  const runners = (health?.runners ?? []).filter((r) => r.available);
  const runner = runners.find((r) => r.name === runnerPick) ?? runners.find((r) => r.name === health?.runner) ?? runners[0];
  const active = machines.find((m) => m.id === activeMachineId);
  // This computer has no live view or USB: the user is sitting at it.
  const remote = !!active && !isLocal(active) && !needsPairing(active);
  const streamState = useStream();
  const live = streamState.status === "connected" || streamState.status === "connecting";

  useEffect(() => {
    if (!paletteOpen) {
      setSearch("");
      setTarget(null);
      setRunnerPick(null);
    }
  }, [paletteOpen]);

  const close = () => set({ paletteOpen: false });
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const ask = () => {
    const prompt = search.trim();
    if (!prompt || !computer) return;
    close();
    askAgent(computer.id, prompt, runner?.name);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const m = paired[Number(e.key) - 1];
      if (m) {
        e.preventDefault();
        e.stopPropagation();
        setTarget(m.id);
        setRunnerPick(null);
      }
    } else if (e.key === "Tab" && runners.length > 1) {
      e.preventDefault();
      const i = runners.findIndex((r) => r.name === runner?.name);
      setRunnerPick(runners[(i + (e.shiftKey ? runners.length - 1 : 1)) % runners.length]!.name);
    }
  };

  const names = new Map(machines.map((m) => [m.id, m]));
  const sessions = all.flatMap((l) => l.sessions.map((s) => ({ machineId: l.machineId, s })));

  return (
    <Dialog open={paletteOpen} onOpenChange={(o) => set({ paletteOpen: o })}>
      <DialogContent showClose={false} className="top-[18%] w-[600px] max-w-[92vw] -translate-y-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Search or ask an agent</DialogTitle>
        <Command loop filter={match} onKeyDown={onKeyDown}>
          <CommandInput placeholder="Search or ask an agent…" value={search} onValueChange={setSearch} />
          {computer && (
            <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-[11.5px] text-muted-foreground">
              Ask
              <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-foreground">
                <AgentAvatar runner={runner?.name} size="sm" /> {runner?.label ?? runnerLabel(runner?.name)}
              </span>
              on
              <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-foreground">
                {isLocal(computer) ? <Laptop className="size-3" /> : <Monitor className="size-3" />} {computer.name}
              </span>
              <span className="ml-auto flex items-center gap-1">
                {runners.length > 1 && <><Kbd>Tab</Kbd> agent</>}
                {paired.length > 1 && <><Kbd>{MOD}</Kbd><Kbd>1–{Math.min(9, paired.length)}</Kbd> computer</>}
              </span>
            </div>
          )}
          <CommandList className="max-h-[360px]">
            <CommandEmpty>No results</CommandEmpty>
            {search.trim() && computer && (
              <CommandGroup>
                <CommandItem value={ASK} onSelect={ask}>
                  <AgentAvatar runner={runner?.name} size="sm" />
                  <span className="min-w-0 flex-1 truncate">Ask {runner?.label ?? "the agent"}: <span className="font-medium">{search.trim()}</span></span>
                  <CornerDownLeft className="text-muted-foreground" />
                </CommandItem>
              </CommandGroup>
            )}
            {sessions.length > 0 && (
              <CommandGroup heading="Conversations">
                {sessions.map(({ machineId, s }) => (
                  <CommandItem key={`${machineId}/${s.id}`} value={`${machineId}/${s.id}`} keywords={[s.title, s.handle ? `@${s.handle}` : "", names.get(machineId)?.name ?? ""]}
                    onSelect={run(() => openSession(machineId, s.id))}>
                    <AgentAvatar runner={s.runner} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    {s.waiting ? <WaitingIcon /> : s.activeTaskId && <StatusIcon status={s.status} />}
                    <span className={cn("shrink-0 text-[11px] text-muted-foreground")}>{names.get(machineId)?.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="Commands">
              {active && !needsPairing(active) && <CommandItem onSelect={run(() => newChatOn(active.id))}><SquarePen /> New chat</CommandItem>}
              {paired.filter((m) => m.id !== activeMachineId).map((m) => (
                <CommandItem key={m.id} value={`new chat on ${m.name}`} onSelect={run(() => newChatOn(m.id))}><SquarePen /> New chat on {m.name}</CommandItem>
              ))}
              {remote && !live && <CommandItem onSelect={run(onConnect)}><Plug /> Wake the screen</CommandItem>}
              {remote && live && <CommandItem onSelect={run(() => stream.disconnect())}><Plug /> Put the screen to sleep</CommandItem>}
              {remote && <CommandItem onSelect={run(() => set({ filesOpen: true }))}><Folder /> Files</CommandItem>}
              {remote && <CommandItem onSelect={run(() => set({ usbOpen: true }))}><Usb /> Share a USB device</CommandItem>}
              <CommandItem onSelect={run(() => set({ sidebarOpen: !sidebarOpen }))}><PanelLeft /> {sidebarOpen ? "Hide sidebar" : "Show sidebar"}</CommandItem>
              <CommandItem onSelect={run(() => useApp.getState().togglePreview())}><PanelRight /> {previewOpen ? "Hide side panel" : "Show side panel"}</CommandItem>
              <CommandItem value="needs you waiting questions approvals" onSelect={run(() => set({ view: "needs" }))}><WaitingIcon /> Needs you</CommandItem>
              <CommandItem onSelect={run(() => set({ theme: "light" }))}><Sun /> Light theme</CommandItem>
              <CommandItem onSelect={run(() => set({ theme: "dark" }))}><Moon /> Dark theme</CommandItem>
              <CommandItem onSelect={run(() => useApp.getState().openAdd())}><Plus /> Add a computer</CommandItem>
              <CommandItem onSelect={run(() => openSettings())}><Settings /> Settings</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
