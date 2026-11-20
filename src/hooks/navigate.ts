import { chat } from "@/hooks/useChat";
import { useApp } from "@/store/app";
import { useComposer } from "@/store/composer";

// Moving between computers and conversations from anywhere (sidebar, ⌘K, Needs you): a computer that
// is not open opens on the conversation through its remembered session.

export function openSession(machineId: string, sessionId: string): void {
  const app = useApp.getState();
  app.set({ view: "chat" });
  if (app.activeMachineId === machineId && chat.machineId === machineId) {
    void chat.open(sessionId);
    return;
  }
  app.rememberSession(machineId, sessionId);
  app.selectMachine(machineId);
}

export function newChatOn(machineId: string): void {
  const app = useApp.getState();
  app.set({ view: "chat" });
  if (app.activeMachineId === machineId && chat.machineId === machineId) {
    if (chat.ready && !chat.submitting) chat.newChat();
  } else {
    app.rememberSession(machineId, null);
    app.selectMachine(machineId);
  }
  useComposer.getState().focus();
}

let pendingAsk: { machineId: string; runner?: string; prompt: string } | null = null;

/** Starts a new conversation on any computer with the given agent and prompt (⌘K "Ask"). */
export function askAgent(machineId: string, prompt: string, runner?: string): void {
  pendingAsk = { machineId, runner, prompt };
  const app = useApp.getState();
  app.set({ view: "chat" });
  if (app.activeMachineId === machineId && chat.machineId === machineId) {
    if (chat.sessionId) chat.newChat();
    flushAsk();
    return;
  }
  app.rememberSession(machineId, null);
  app.selectMachine(machineId);
}

/** Sends a pending ask once its computer's conversations are loaded (called on every Chat change). */
export function flushAsk(): void {
  const ask = pendingAsk;
  if (!ask || !chat.ready || chat.machineId !== ask.machineId || chat.sessionId || chat.submitting) return;
  pendingAsk = null;
  void chat.submit(ask.prompt, { runner: ask.runner });
}
