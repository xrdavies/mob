import { UpdateNotice } from "@/components/UpdateNotice";
import { FilesDialog } from "@/components/FilesDialog";
import { UsbDialog } from "@/components/UsbDialog";
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { supports } from "@/api/client";
import { CommandPalette } from "@/components/CommandPalette";
import { Composer } from "@/components/composer/Composer";
import { ActivityPanel, PreviewPanel } from "@/components/preview/PreviewPanel";
import { Spinner } from "@/components/StatusIcon";
import { isLocal } from "@/lib/machines";
import { connectLocal } from "@/store/local";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { AddComputerDialog } from "@/components/add/AddComputerDialog";
import { useLocalStatus } from "@/components/local/LocalSetup";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Timeline } from "@/components/timeline/Timeline";
import { TitleBar } from "@/components/TitleBar";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { chat, useChat } from "@/hooks/useChat";
import { SyncStatus } from "@/components/timeline/SyncStatus";
import { useHealth, useMachineEvents, useQueue } from "@/hooks/useMachine";
import { useQuestionAlerts } from "@/hooks/useQuestionAlerts";
import { RouteBanner } from "@/components/MachineRoute";
import { baseUrl, needsPairing, useActiveMachine, useApp, type Machine } from "@/store/app";
import { useComposer } from "@/store/composer";
import { log } from "@/store/log";

function useDarkMode(): boolean {
  const theme = useApp((s) => s.theme);
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return dark;
}

/**
 * This computer's mobd no longer accepts this Desktop (revoked, auth reset). Reconnecting creates a
 * new invitation, so it only happens when the user asks: never on its own around a revocation.
 */
function ReconnectLocal({ machine }: { machine: Machine }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="flex flex-1 items-center justify-center bg-background">
      <div className="w-[380px] rounded-2xl border bg-background p-6 text-center shadow-panel">
        <img src="/logo.svg" alt="Mob Screen Buddy" className="mx-auto size-20" />
        <h2 className="mt-3 text-base font-semibold">Reconnect {machine.name}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          mobd on this computer no longer accepts this app: its access was removed or reset. Reconnect to pair again.
        </p>
        <Button className="mt-4" disabled={busy} onClick={() => {
          setBusy(true);
          setError("");
          connectLocal().catch((err) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false));
        }}>
          {busy && <Spinner />} Reconnect this computer
        </Button>
        {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
      </div>
    </div>
  );
}

function NoMachine() {
  const openSettings = useApp((s) => s.openSettings);
  const { data: local, isLoading } = useLocalStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // mobd already running here: connecting changes nothing on the computer, so do it right here.
  // Installing or starting it goes through the setup step, which says what will happen.
  const start = () => {
    if (!local?.running) return useApp.getState().openAdd(undefined, "local");
    setBusy(true);
    setError("");
    connectLocal().catch((err) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-1 items-center justify-center bg-background">
      <div className="w-[380px] rounded-2xl border bg-background p-8 text-center shadow-panel">
        <img src="/logo.svg" alt="Mob Screen Buddy" className="mx-auto size-20" />
        <h2 className="mt-3 text-base font-semibold">Welcome to Mob</h2>
        {local?.supported ? (
          <>
            <p className="mt-1 text-[13px] text-muted-foreground">Chat with AI agents that work on this computer.</p>
            <Button className="mt-5" disabled={busy || isLoading} onClick={start}>{busy && <Spinner />} Start with this computer</Button>
            {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
            <Button variant="link" className="mt-1 w-full" onClick={() => useApp.getState().openAdd(undefined, "link")}>Add another computer</Button>
          </>
        ) : (
          <>
            <p className="mt-1 text-[13px] text-muted-foreground">Add the office Mac or Linux machine your agents work on.</p>
            <Button className="mt-5" disabled={isLoading} onClick={() => useApp.getState().openAdd(undefined, "link")}>Add a computer</Button>
          </>
        )}
        <Button variant="link" className="w-full text-muted-foreground" onClick={() => openSettings("about")}>What is Mob?</Button>
      </div>
    </div>
  );
}

function NeedsPairing({ machine }: { machine: Machine }) {
  if (isLocal(machine)) return <ReconnectLocal machine={machine} />;
  return (
    <div className="flex flex-1 flex-col bg-background">
      <RouteBanner machine={machine} />
      <div className="flex flex-1 items-center justify-center">
        <div className="w-[380px] rounded-2xl border bg-background p-6 text-center shadow-panel">
          <img src="/logo.svg" alt="Mob Screen Buddy" className="mx-auto size-20" />
          <h2 className="mt-3 text-base font-semibold">{machine.name} needs pairing</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            This device has no valid credential for the office computer. Run <code className="font-mono">mobd link</code> there and paste
            the new link. Your conversations stay on the office computer.
          </p>
          <Button className="mt-4" onClick={() => useApp.getState().openAdd(machine.id)}>Pair again</Button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const machine = useActiveMachine();
  const { sidebarOpen, previewOpen, filesOpen, usbOpen, savedSessions, rememberSession, set, togglePreview } = useApp();
  const chatState = useChat();
  const base = baseUrl(machine);
  const health = useHealth(machine);
  const { data: queue } = useQueue(base, supports(health.data, "queue"));
  const dark = useDarkMode();
  useMachineEvents(machine);
  useQuestionAlerts(chatState);

  // Load the selected machine's conversations; restore its last session.
  useEffect(() => {
    if (!machine || needsPairing(machine)) {
      chat.detach();
      return;
    }
    log(`selected machine: ${machine.name}`, "info");
    void chat.setMachine(machine.id, base, useApp.getState().savedSessions[machine.id], machine.serverId ?? machine.id);
  }, [machine?.id, base, needsPairing(machine)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from offline once mobd answers again; returning to the app catches up with changes.
  useEffect(() => {
    if (health.data && chat.sync === "offline") chat.retrySync();
  }, [health.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onFocus = () => chat.resync();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (machine && chatState.ready && chatState.machineId === machine.id && savedSessions[machine.id] !== chatState.sessionId) {
      rememberSession(machine.id, chatState.sessionId);
    }
  }, [chatState.sessionId, chatState.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // The panel owns the view, so it does the connecting; opening it first if needed.
  const connectLive = () => {
    togglePreview(true);
    set({ liveConnect: Date.now() });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const st = useApp.getState();
      if (e.key === "Escape" && st.fullscreen) {
        e.preventDefault();
        set({ fullscreen: false });
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        set({ paletteOpen: !st.paletteOpen });
      } else if (mod && e.key.toLowerCase() === "n" && chat.ready && !chat.submitting) {
        e.preventDefault();
        chat.newChat();
        useComposer.getState().focus();
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (e.shiftKey) st.togglePreview();
        else set({ sidebarOpen: !st.sidebarOpen });
      } else if (mod && e.key === ",") {
        e.preventDefault();
        st.openSettings();
      } else if (mod && /^[1-9]$/.test(e.key)) {
        const s = chat.sessions[Number(e.key) - 1];
        if (s) {
          e.preventDefault();
          void chat.open(s.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        <UpdateNotice />
        <TitleBar machine={machine} health={health.data} healthError={health.isError} queue={queue}
          refetchHealth={() => void health.refetch()} dark={dark} />
        <div className="flex min-h-0 flex-1">
          {sidebarOpen && <Sidebar />}
          {machine && needsPairing(machine) ? (
            <NeedsPairing machine={machine} />
          ) : machine ? (
            <main className="flex min-w-0 flex-1 flex-col bg-background">
              <div className="flex h-10 shrink-0 items-center border-b px-4">
                <h1 className="min-w-0 truncate text-[13px] font-medium">
                  {chatState.session?.title ?? (chatState.loading ? "Loading…" : "New chat")}
                </h1>
                <SyncStatus />
              </div>
              <RouteBanner machine={machine} />
              <Timeline machineName={machine.name} />
              <Composer machineId={machine.id} machineName={machine.name} health={health.data} />
            </main>
          ) : (
            <NoMachine />
          )}
          {/* Closed means unmounted: no snapshots and no live view connection, as in the mobile apps. */}
          {machine && previewOpen && (isLocal(machine)
            ? <ActivityPanel health={health.data} queue={queue} />
            : <PreviewPanel machine={machine} health={health.data} queue={queue} />)}
        </div>
      </div>
      <SettingsDialog />
      <AddComputerDialog />
      {machine && !isLocal(machine) && <FilesDialog machine={machine} health={health.data} open={filesOpen} onOpenChange={(o) => set({ filesOpen: o })} />}
      {machine && !isLocal(machine) && <UsbDialog machine={machine} health={health.data} open={usbOpen} onOpenChange={(o) => set({ usbOpen: o })} />}
      <CommandPalette onConnect={connectLive} />
      <Toaster theme={dark ? "dark" : "light"} position="bottom-center" />
    </TooltipProvider>
  );
}
