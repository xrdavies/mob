import { useSyncExternalStore } from "react";
import { Chat } from "@/lib/chat";
import { historyStore } from "@/lib/historyStore";
import { log } from "@/store/log";

// One conversation controller for the whole App; React re-renders on its changes.
let version = 0;
const listeners = new Set<() => void>();

export const chat = new Chat(() => {
  version++;
  for (const l of listeners) l();
}, (line) => log(line), undefined, historyStore);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChat(): Chat {
  useSyncExternalStore(subscribe, () => version);
  return chat;
}
