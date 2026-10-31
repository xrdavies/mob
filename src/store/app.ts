import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { configureAuth } from "@/lib/auth";
import { currentAddress, pairMachine, withAddresses, type Machine } from "@/lib/machines";
import { historyStore } from "@/lib/historyStore";
import { deleteSecret, getSecret, loadSecrets, setSecret, tokenAccount } from "@/lib/secrets";
import { uid } from "@/lib/utils";
import { log } from "@/store/log";
import { migrateApp } from "@/store/migrate";

export type { Machine, MachineAddress } from "@/lib/machines";
export { baseUrl, needsPairing } from "@/lib/machines";

export interface PairResult {
  /** The machine to pair again; unset adds one, or an address to the saved machine of that office. */
  id?: string;
  name: string;
  origin: string;
  serverId: string;
  clientId: string;
  token: string;
}

export type Theme = "system" | "light" | "dark";
export type SettingsTab = "machines" | "appearance" | "log" | "about";

// A new chat's choices on this device, until the chat exists: keyed by machine ID (runner) and
// "<machine>/<runner>" (model, effort). In memory only; conversations keep theirs in mobd.
export interface TurnPrefs {
  runner?: string;
  model?: string;
  effort?: string;
}

interface Persisted {
  machines: Machine[];
  activeMachineId: string | null;
  savedSessions: Record<string, string | null>;
  collapsed: Record<string, boolean>;
  sidebarOpen: boolean;
  previewOpen: boolean;
  theme: Theme;
}

interface Ephemeral {
  turnPrefs: Record<string, TurnPrefs>;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  editMachineId: string | null;
  /** An agent of the edited machine to bring into view ("" for its Agents section). */
  settingsFocus: string | null;
  paletteOpen: boolean;
  filesOpen: boolean;
  fullscreen: boolean;
  /** Set to ask the desktop panel to connect the live view (from the command palette). */
  liveConnect: number;
}

interface Actions {
  set: (patch: Partial<Persisted & Ephemeral>) => void;
  selectMachine: (id: string) => void;
  /** Shows or hides the desktop panel; hiding it also leaves full screen. */
  togglePreview: (open?: boolean) => void;
  /** Renames a paired machine and its addresses ("" shows the kind again). */
  saveMachine: (m: { id: string; name: string; labels?: Record<string, string> }) => void;
  /** Live view quality from the view itself; "auto" clears it. */
  setLiveQuality: (id: string, quality: NonNullable<Machine["liveQuality"]>) => void;
  /** Remembers which transport the live view ended up on. */
  setLiveWebSocket: (id: string, ws: boolean) => void;
  /**
   * Stores the new credential, then creates the machine, pairs a saved address again, or adds the
   * address to the office's machine; the paired address is used from then on.
   */
  completePairing: (p: PairResult) => Promise<string>;
  /** mobd refused the token of one address (the one in use when unset). */
  markNeedsPairing: (id: string, addressId?: string) => void;
  /** Uses another of the machine's addresses; the app never switches by itself. */
  selectRoute: (id: string, addressId: string) => void;
  /** Removes one address from this device; the machine goes with its last one. */
  removeAddress: (id: string, addressId: string) => void;
  deleteMachine: (id: string) => void;
  rememberSession: (machineId: string, sessionId: string | null) => void;
  setTurnPrefs: (key: string, prefs: TurnPrefs) => void;
  clearTurnPrefs: (key: string) => void;
  openSettings: (tab?: SettingsTab, editMachineId?: string | null, focus?: string | null) => void;
}

export type AppState = Persisted & Ephemeral & Actions;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

// Seeds state from the v1 client's keys the first time v2+ runs. Those machines still need pairing.
function initial(): Persisted {
  // No machine is made up: a fresh install starts empty and adds one from a mobd link.
  let machines = read<Machine[]>("mob.machines");
  if (!Array.isArray(machines)) machines = [];
  let active: string | null = null;
  try {
    active = localStorage.getItem("mob.activeMachineId");
  } catch {
    /* storage unavailable */
  }
  const saved = read<Record<string, string | null>>("mob.activeSessionByMachine");
  return {
    machines: machines.map((m) => withAddresses({ ...m, needsPairing: true })),
    activeMachineId: machines.some((m) => m.id === active) ? active : machines[0]?.id ?? null,
    savedSessions: saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {},
    collapsed: {},
    sidebarOpen: true,
    previewOpen: false,
    theme: "system",
  };
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      ...initial(),
      turnPrefs: {},
      settingsOpen: false,
      settingsTab: "machines",
      editMachineId: null,
      settingsFocus: null,
      paletteOpen: false,
      filesOpen: false,
      fullscreen: false,
      liveConnect: 0,
      set: (patch) => set(patch),
      selectMachine: (id) => set({ activeMachineId: id, fullscreen: false }),
      togglePreview: (open = !get().previewOpen) => set(open ? { previewOpen: true } : { previewOpen: false, fullscreen: false }),
      saveMachine: (m) =>
        set({
          machines: get().machines.map((x) =>
            x.id === m.id
              ? {
                ...x, name: m.name.trim(),
                addresses: x.addresses.map((a) => {
                  const label = m.labels?.[a.id]?.trim();
                  if (m.labels?.[a.id] === undefined) return a;
                  const { label: _, ...rest } = a;
                  return label ? { ...rest, label } : rest;
                }),
              }
              : x),
        }),
      setLiveQuality: (id, quality) =>
        set({ machines: get().machines.map((x) => (x.id === id ? { ...x, liveQuality: quality === "auto" ? undefined : quality } : x)) }),
      setLiveWebSocket: (id, ws) =>
        set({ machines: get().machines.map((x) => (x.id === id ? { ...x, liveWebSocket: ws || undefined } : x)) }),
      completePairing: async (p) => {
        const machines0 = get().machines;
        const saved = machines0.find((x) => x.id === p.id) ?? machines0.find((x) => x.serverId === p.serverId);
        const base: Machine = saved ?? { id: uid(), name: p.name.trim(), addresses: [] };
        const { machine, address, dropped } = pairMachine(base, p.origin, p.serverId, p.clientId, uid);
        // The keychain write comes first: an address and its credential change together.
        await setSecret(tokenAccount(address.id), p.token);
        for (const account of dropped) deleteSecret(account).catch((err) => log(`keychain delete failed: ${String(err)}`, "error"));
        const machines = saved ? get().machines.map((x) => (x.id === machine.id ? machine : x)) : [...get().machines, machine];
        log(`${machine.name}: paired with ${p.origin}`);
        set({ machines, activeMachineId: get().activeMachineId ?? machine.id });
        return machine.id;
      },
      markNeedsPairing: (id, addressId) => {
        const machine = get().machines.find((m) => m.id === id);
        const address = machine && (machine.addresses.find((a) => a.id === addressId) ?? (addressId ? undefined : currentAddress(machine)));
        if (!machine || !address || address.needsPairing) return;
        log(`${machine.name}: mobd rejected the credential for ${address.url}; pairing needed`, "error");
        set({
          machines: get().machines.map((m) =>
            m.id === id ? { ...m, addresses: m.addresses.map((a) => (a.id === address.id ? { ...a, needsPairing: true } : a)) } : m),
        });
      },
      selectRoute: (id, addressId) => {
        const machine = get().machines.find((m) => m.id === id);
        const address = machine?.addresses.find((a) => a.id === addressId);
        if (!machine || !address || currentAddress(machine)?.id === addressId) return;
        log(`${machine.name}: using ${address.url}`);
        set({ machines: get().machines.map((m) => (m.id === id ? { ...m, route: addressId } : m)) });
      },
      removeAddress: (id, addressId) => {
        const machine = get().machines.find((m) => m.id === id);
        if (!machine) return;
        if (machine.addresses.length < 2) return get().deleteMachine(id);
        deleteSecret(tokenAccount(addressId)).catch((err) => log(`keychain delete failed: ${String(err)}`, "error"));
        set({
          machines: get().machines.map((m) => m.id !== id ? m : {
            ...m, addresses: m.addresses.filter((a) => a.id !== addressId), route: m.route === addressId ? undefined : m.route,
          }),
        });
      },
      deleteMachine: (id) => {
        const machine = get().machines.find((m) => m.id === id);
        for (const a of machine?.addresses ?? []) {
          deleteSecret(tokenAccount(a.id)).catch((err) => log(`keychain delete failed: ${String(err)}`, "error"));
        }
        if (machine) forgetHistory(machine);
        const machines = get().machines.filter((m) => m.id !== id);
        const savedSessions = { ...get().savedSessions };
        delete savedSessions[id];
        const activeMachineId = get().activeMachineId === id ? machines[0]?.id ?? null : get().activeMachineId;
        set({ machines, savedSessions, activeMachineId });
      },
      rememberSession: (machineId, sessionId) => {
        if (get().savedSessions[machineId] === sessionId) return;
        set({ savedSessions: { ...get().savedSessions, [machineId]: sessionId } });
      },
      setTurnPrefs: (machineId, prefs) =>
        set({ turnPrefs: { ...get().turnPrefs, [machineId]: { ...get().turnPrefs[machineId], ...prefs } } }),
      clearTurnPrefs: (key) => {
        const { [key]: _, ...rest } = get().turnPrefs;
        set({ turnPrefs: rest });
      },
      openSettings: (tab = "machines", editMachineId = null, focus = null) =>
        set({ settingsOpen: true, settingsTab: tab, editMachineId: editMachineId ?? get().activeMachineId, settingsFocus: focus }),
    }),
    {
      name: "mob.app",
      version: 7,
      migrate: (state, version) => migrateApp(state, version) as Persisted,
      storage: createJSONStorage(() => localStorage),
      partialize: (s): Persisted => ({
        machines: s.machines, activeMachineId: s.activeMachineId, savedSessions: s.savedSessions,
        collapsed: s.collapsed, sidebarOpen: s.sidebarOpen, previewOpen: s.previewOpen, theme: s.theme,
      }),
    },
  ),
);

export function useActiveMachine(): Machine | null {
  return useApp((s) => s.machines.find((m) => m.id === s.activeMachineId) ?? null);
}

/**
 * Loads every machine's secrets into memory before the first request, and marks machines without
 * a credential as needing pairing.
 */
export async function loadMachineSecrets(): Promise<void> {
  const { machines } = useApp.getState();
  const failed = await loadSecrets(machines.flatMap((m) => m.addresses.map((a) => tokenAccount(a.id))));
  for (const account of failed) log(`keychain read failed: ${account}`, "error");
  useApp.setState({
    machines: useApp.getState().machines.map((m) => ({
      ...m,
      addresses: m.addresses.map((a) =>
        !a.needsPairing && !getSecret(tokenAccount(a.id)) && !failed.includes(tokenAccount(a.id)) ? { ...a, needsPairing: true } : a),
    })),
  });
}


/** Deletes the machine's local copy of conversations (keyed like Chat.setMachine). */
function forgetHistory(m: Machine): void {
  historyStore.remove(m.serverId ?? m.id).catch((err) => log(`removing the local copy failed: ${String(err)}`, "error"));
}

/** The saved addresses at an origin, with their machine. */
const addressesAt = (base: string) =>
  useApp.getState().machines.flatMap((m) => m.addresses.filter((a) => a.url.trim().replace(/\/$/, "") === base).map((a) => ({ m, a })));

configureAuth({
  // An unpaired address sends nothing: never a credential to an address it was not paired on.
  token: (base) => {
    const hit = addressesAt(base).find(({ a }) => !a.needsPairing);
    return hit && getSecret(tokenAccount(hit.a.id));
  },
  // mobd no longer accepts this device (revoked or reset): its saved conversations go too.
  unauthorized: (base) => {
    for (const { m, a } of addressesAt(base)) {
      useApp.getState().markNeedsPairing(m.id, a.id);
      forgetHistory(m);
    }
  },
});
