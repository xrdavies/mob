import { Folder, MessageSquare, Monitor, Moon, PanelLeft, Plug, Settings, SquarePen, Sun } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { StatusIcon } from "@/components/StatusIcon";
import { chat, useChat } from "@/hooks/useChat";
import { stream } from "@/lib/stream";
import { needsPairing, useApp } from "@/store/app";
import { useComposer } from "@/store/composer";

export function CommandPalette({ onConnect }: { onConnect: () => void }) {
  const { paletteOpen, machines, activeMachineId, set, selectMachine, openSettings, sidebarOpen, previewOpen } = useApp();
  const chatState = useChat();
  const machine = machines.find((m) => m.id === activeMachineId);
  const close = () => set({ paletteOpen: false });
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <Dialog open={paletteOpen} onOpenChange={(o) => set({ paletteOpen: o })}>
      <DialogContent showClose={false} className="top-[22%] w-[560px] max-w-[92vw] -translate-y-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command loop>
          <CommandInput placeholder="Search conversations and commands…" />
          <CommandList>
            <CommandEmpty>No results</CommandEmpty>
            <CommandGroup heading="Actions">
              <CommandItem onSelect={run(() => { chat.newChat(); useComposer.getState().focus(); })}><SquarePen /> New chat</CommandItem>
              <CommandItem onSelect={run(onConnect)}><Plug /> Connect live view</CommandItem>
              <CommandItem onSelect={run(() => stream.disconnect())}><Plug /> Disconnect live view</CommandItem>
              <CommandItem onSelect={run(() => set({ sidebarOpen: !sidebarOpen }))}><PanelLeft /> Toggle sidebar</CommandItem>
              <CommandItem onSelect={run(() => useApp.getState().togglePreview())}><Monitor /> {previewOpen ? "Hide desktop" : "Show desktop"}</CommandItem>
              {machine && !needsPairing(machine) && <CommandItem onSelect={run(() => set({ filesOpen: true }))}><Folder /> Open Files</CommandItem>}
              <CommandItem onSelect={run(() => set({ theme: "light" }))}><Sun /> Light theme</CommandItem>
              <CommandItem onSelect={run(() => set({ theme: "dark" }))}><Moon /> Dark theme</CommandItem>
              <CommandItem onSelect={run(() => openSettings())}><Settings /> Settings</CommandItem>
            </CommandGroup>
            {chatState.sessions.length > 0 && (
              <CommandGroup heading="Conversations">
                {chatState.sessions.map((s) => (
                  <CommandItem key={s.id} value={`${s.title} ${s.id}`} onSelect={run(() => void chat.open(s.id))}>
                    <MessageSquare />
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    {s.activeTaskId && <StatusIcon status={s.status} />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {machines.length > 1 && (
              <CommandGroup heading="Machines">
                {machines.filter((m) => m.id !== activeMachineId).map((m) => (
                  <CommandItem key={m.id} value={`machine ${m.name}`} onSelect={run(() => selectMachine(m.id))}><Monitor /> Switch to {m.name}</CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
