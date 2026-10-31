import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Session } from "@/api/types";
import { MemoryHistory, sessionRow, type HistoryStore, type StoredTurn } from "@/lib/history";

interface Saved {
  session: string;
  syncRev: number;
  oldest: number | null;
  cursor: string | null;
  turns: { seq: number; data: string }[];
}

// The SQLite copy in the Tauri backend (src-tauri/src/history.rs); turns travel as JSON text.
const tauriHistory: HistoryStore = {
  async load(machine, id, before, limit) {
    const s = await invoke<Saved | null>("history_load", { machine, id, before, limit });
    if (!s) return null;
    return {
      session: JSON.parse(s.session) as Session, syncRev: s.syncRev, oldest: s.oldest, cursor: s.cursor,
      turns: s.turns.map((t) => JSON.parse(t.data) as StoredTurn),
    };
  },
  async list(machine) {
    return (await invoke<string[]>("history_list", { machine })).map((s) => JSON.parse(s) as Session);
  },
  async save(machine, session, syncRev, turns, replace, keep) {
    await invoke("history_save", {
      machine, replace, keep,
      conversation: { id: session.id, session: JSON.stringify(sessionRow(session)), syncRev },
      turns: turns.map(({ cursor, ...t }) => ({
        id: t.task.id, seq: t.task.seq ?? 0, rev: t.task.rev ?? 0, cursor: cursor ?? null, data: JSON.stringify(t),
      })),
    });
  },
  async remove(machine, id) {
    await invoke("history_remove", { machine, id: id ?? null });
  },
  async prune(machine, ids) {
    await invoke("history_prune", { machine, ids });
  },
  async clear() {
    await invoke("history_clear");
  },
  async size() {
    return invoke<number>("history_size");
  },
};

export const historyStore: HistoryStore = isTauri() ? tauriHistory : new MemoryHistory();
