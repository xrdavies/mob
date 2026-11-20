import { Bell, Laptop, Monitor, Palette, Plus, Settings } from "lucide-react";
import { AppearancePage, GeneralPage, LogPage, NotificationsPage } from "@/components/settings/AppPages";
import { ComputerPage } from "@/components/settings/ComputerPage";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useHealth } from "@/hooks/useMachine";
import { isLocal } from "@/lib/machines";
import { cn } from "@/lib/utils";
import { needsPairing, useApp, type Machine, type SettingsTab } from "@/store/app";

export { ChecksList } from "@/components/settings/ComputerPage";

const navItem = (on: boolean) => cn(
  "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
  on ? "bg-foreground/[0.07] font-medium text-foreground" : "text-foreground/80 hover:bg-foreground/[0.04]",
);

function ComputerNav({ machine, on, onClick }: { machine: Machine; on: boolean; onClick: () => void }) {
  const { data: health, isError } = useHealth(machine);
  const failing = Object.values(health?.checks ?? {}).some((c) => !c.ok && !c.unknown);
  const tone = needsPairing(machine) ? "bg-warning" : isError ? "bg-muted-foreground/40" : !health ? "bg-muted-foreground/25" : failing ? "bg-warning" : "bg-success";
  return (
    <button type="button" className={navItem(on)} onClick={onClick}>
      {isLocal(machine) ? <Laptop /> : <Monitor />}
      <span className="min-w-0 flex-1 truncate">{machine.name}</span>
      <span className={cn("size-1.5 rounded-full", tone)} />
    </button>
  );
}

/**
 * Settings (docs/desktop-redesign, Settings): a sheet with the app's pages and one page per computer
 * in the left column, "Add a computer" at the end of the list.
 */
export function SettingsDialog() {
  const { settingsOpen, settingsTab, editMachineId, machines, set, openAdd } = useApp();
  const computer = settingsTab === "computer" ? machines.find((m) => m.id === editMachineId) : undefined;
  const page: SettingsTab = settingsTab === "computer" && !computer ? "general" : settingsTab;
  const pages: { value: SettingsTab; label: string; icon: typeof Settings }[] = [
    { value: "general", label: "General", icon: Settings },
    { value: "appearance", label: "Appearance", icon: Palette },
    { value: "notifications", label: "Notifications", icon: Bell },
  ];
  return (
    <Dialog open={settingsOpen} onOpenChange={(o) => set({ settingsOpen: o })}>
      <DialogContent className="flex h-[640px] max-h-[90vh] w-[860px] max-w-[94vw] overflow-hidden p-0">
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r bg-sidebar p-2" aria-label="Settings">
          <DialogTitle className="px-2.5 pb-2 pt-1.5 text-[13px]">Settings</DialogTitle>
          <DialogDescription className="sr-only">App and computer settings</DialogDescription>
          {pages.map((p) => (
            <button key={p.value} type="button" className={navItem(page === p.value || (p.value === "general" && page === "log"))}
              onClick={() => set({ settingsTab: p.value })}>
              <p.icon /> {p.label}
            </button>
          ))}
          <p className="mt-3 px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Computers</p>
          {machines.map((m) => (
            <ComputerNav key={m.id} machine={m} on={page === "computer" && computer?.id === m.id}
              onClick={() => set({ settingsTab: "computer", editMachineId: m.id, computerTab: "general" })} />
          ))}
          <button type="button" className={cn(navItem(false), "text-muted-foreground")} onClick={() => openAdd()}>
            <Plus /> Add a computer
          </button>
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-panel px-6 pb-6 pt-5">
          {page === "general" && <GeneralPage />}
          {page === "appearance" && <AppearancePage />}
          {page === "notifications" && <NotificationsPage />}
          {page === "log" && <LogPage />}
          {page === "computer" && computer && <ComputerPage key={computer.id} machine={computer} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
