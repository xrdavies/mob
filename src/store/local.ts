// This computer's mobd, managed by Desktop (mobd docs/mob-desktop-local-mobd.md): status, setup and
// pairing Desktop with it. The native side (src-tauri/src/local.rs) does the work; this drives it.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isLocal } from "@/lib/machines";
import { pair, parsePairLink } from "@/lib/pairing";
import { useApp } from "@/store/app";
import { log } from "@/store/log";

export interface LocalHealth {
  listen?: string;
  /** Since mobd 0.5.2; older ones report only listen. */
  serverId?: string;
  version?: string;
  executable?: string;
  loginStartup?: boolean;
}

export interface LocalStatus {
  supported: boolean;
  binary?: string | null;
  running: boolean;
  health?: LocalHealth | null;
  path: string;
  configured: boolean;
  home: string;
}

/** The name this Desktop has in mobd's device list. */
export const LOCAL_DEVICE_NAME = "Mob Desktop on this computer";

export async function localStatus(): Promise<LocalStatus | null> {
  if (!isTauri()) return null;
  return invoke<LocalStatus>("local_status");
}

export const defaultWorkdir = (s: LocalStatus) => `${s.home.replace(/\/$/, "")}/Mob`;

/** Installs mobd with the official release's checks; `stage` follows the steps. */
export async function installLocal(stage: (text: string) => void): Promise<string> {
  const stop = await listen<string>("local-install", (e) => stage(e.payload));
  try {
    const version = await invoke<string>("local_install");
    log(`installed mobd ${version}`);
    return version;
  } finally {
    stop();
  }
}

/** First setup: config with this working directory if there is none, then the login service. */
export async function setupLocal(workdir: string): Promise<void> {
  const out = await invoke<string>("local_setup", { workdir });
  log(`local mobd started: ${out.split("\n")[0]}`);
}

export async function localService(action: "start" | "stop" | "restart", login = false): Promise<string> {
  const out = await invoke<string>("local_service", { action, login });
  log(`local mobd ${action}: ${out.split("\n")[0] || "done"}`);
  return out;
}

export const localLogs = (lines = 300) => invoke<string>("local_logs", { lines });
export const localLatest = () => invoke<string>("local_latest");
export const localControl = <T,>(method: "GET" | "POST" | "DELETE", path: string) => invoke<T>("local_control", { method, path });

/**
 * Pairs this Desktop with the running local mobd through its management socket: a one-use invite
 * at the loopback address, redeemed like any pairing link. A machine already paired with the same
 * mobd (over its LAN address) becomes this computer instead of a second entry.
 */
export async function connectLocal(): Promise<string> {
  const { url } = await invoke<{ url: string }>("local_invite");
  const link = parsePairLink(url);
  const paired = await pair(link, LOCAL_DEVICE_NAME);
  const app = useApp.getState();
  const existing = app.machines.find(isLocal);
  const id = await app.completePairing({
    id: existing?.serverId === paired.serverId ? existing.id : undefined,
    name: "This computer", origin: link.origin, ...paired,
  });
  useApp.getState().setLocal(id);
  useApp.getState().selectMachine(id);
  log("paired with this computer's mobd");
  return id;
}
