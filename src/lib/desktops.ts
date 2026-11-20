import type { DesktopInfo, DesktopState, Desktops, DiskInfo, Level, MemoryInfo, QueueReason } from "../api/types.ts";

// Conversation desktops (mobd on Linux, the `sessionDesktops` feature): every conversation has its
// own desktop, started by its first turn, asleep when unused, closed with the conversation.

export const NO_DESKTOP = "No desktop yet — it starts with the conversation's first turn";

const STATES: DesktopState[] = ["starting", "running", "asleep", "waking", "closing", "closed", "failed"];
const LEVELS: Level[] = ["ok", "low", "critical"];

const QUEUE_REASONS: Record<QueueReason, string> = {
  slots: "Waiting for a free slot",
  desktops: "Waiting: the desktop limit is reached",
  memory: "Waiting: the computer is low on memory",
  disk: "Waiting: the computer is low on disk space",
  desktopStarting: "Starting the desktop",
};

/** What a queued task waits for; empty for no reason or one this build does not know. */
export function queueReasonText(reason?: string): string {
  return reason && Object.hasOwn(QUEUE_REASONS, reason) ? QUEUE_REASONS[reason as QueueReason] : "";
}

type Raw = Record<string, unknown>;
const record = (raw: unknown): Raw | null => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Raw) : null);
const num = (m: Raw, k: string) => (typeof m[k] === "number" && Number.isFinite(m[k]) ? (m[k] as number) : 0);
const str = (m: Raw, k: string) => (typeof m[k] === "string" && m[k] ? (m[k] as string) : undefined);
const level = (v: unknown): Level | undefined => (LEVELS.includes(v as Level) ? (v as Level) : undefined);

/** A desktop from GET /desktops or a `desktop` event; null without a session or a known state. */
export function parseDesktop(raw: unknown): DesktopInfo | null {
  const m = record(raw);
  const sessionId = m && str(m, "sessionId");
  if (!m || !sessionId || !STATES.includes(m.state as DesktopState)) return null;
  return {
    sessionId, title: str(m, "title"), display: str(m, "display"),
    width: num(m, "width"), height: num(m, "height"), scale: num(m, "scale") || 1,
    state: m.state as DesktopState, reason: str(m, "reason"),
    memoryBytes: num(m, "memoryBytes"), diskBytes: num(m, "diskBytes"),
    startedAt: str(m, "startedAt"), lastUsedAt: str(m, "lastUsedAt"), activeTaskId: str(m, "activeTaskId"),
    viewers: num(m, "viewers"),
  };
}

export function parseMemory(raw: unknown): MemoryInfo | undefined {
  const m = record(raw);
  const l = m && level(m.level);
  if (!m || !l) return undefined;
  return {
    level: l, availableBytes: num(m, "availableBytes"), totalBytes: num(m, "totalBytes"), pressure: num(m, "pressure"),
    warnPercent: typeof m.warnPercent === "number" ? m.warnPercent : undefined,
    floorPercent: typeof m.floorPercent === "number" ? m.floorPercent : undefined,
  };
}

export function parseDisk(raw: unknown): DiskInfo | undefined {
  const m = record(raw);
  const l = m && level(m.level);
  if (!m || !l) return undefined;
  return { level: l, freeBytes: num(m, "freeBytes"), totalBytes: num(m, "totalBytes"), path: str(m, "path") };
}

const byMemory = (list: DesktopInfo[]) => [...list].sort((a, b) => b.memoryBytes - a.memoryBytes);

/** GET /desktops; malformed entries are dropped, the rest sorted largest memory first. */
export function parseDesktops(raw: unknown): Desktops {
  const m = record(raw) ?? {};
  const list = Array.isArray(m.desktops) ? m.desktops.map(parseDesktop).filter((d): d is DesktopInfo => !!d) : [];
  return { desktops: byMemory(list), memory: parseMemory(m.memory), disk: parseDisk(m.disk) };
}

/** Applies a `desktop` event: a closed desktop leaves the list, any other state replaces the entry. */
export function applyDesktop(current: Desktops | undefined, info: DesktopInfo): Desktops {
  const base = current ?? { desktops: [] };
  const rest = base.desktops.filter((d) => d.sessionId !== info.sessionId);
  return { ...base, desktops: info.state === "closed" ? rest : byMemory([...rest, info]) };
}

/** Applies a `memory` or `disk` event. */
export function applyLevel(current: Desktops | undefined, kind: "memory", info: MemoryInfo): Desktops;
export function applyLevel(current: Desktops | undefined, kind: "disk", info: DiskInfo): Desktops;
export function applyLevel(current: Desktops | undefined, kind: "memory" | "disk", info: MemoryInfo | DiskInfo): Desktops {
  return { ...(current ?? { desktops: [] }), [kind]: info };
}

export type DesktopMark = "running" | "asleep" | null;

/** How the chat list marks a conversation: a desktop that is up (or coming up), asleep, or none. */
export function desktopMark(info?: DesktopInfo): DesktopMark {
  switch (info?.state) {
    case "starting":
    case "running":
    case "waking":
      return "running";
    case "asleep":
      return "asleep";
    default:
      return null;
  }
}

export function desktopOf(desktops: Desktops | undefined, sessionId: string | null | undefined): DesktopInfo | undefined {
  return sessionId ? desktops?.desktops.find((d) => d.sessionId === sessionId) : undefined;
}

export interface Banner {
  /** Changes with either level: a dismissed banner returns when it does. */
  key: string;
  critical: boolean;
  message: string;
}

/** The low memory / low disk banner, or null while both are ok (or unknown). */
export function bannerState(desktops: Desktops | undefined): Banner | null {
  const memory = desktops?.memory?.level ?? "ok";
  const disk = desktops?.disk?.level ?? "ok";
  const low = [memory !== "ok" && "memory", disk !== "ok" && "disk space"].filter(Boolean).join(" and ");
  if (!low) return null;
  const critical = [memory === "critical" && "memory", disk === "critical" && "disk space"].filter(Boolean);
  let message = `The computer is low on ${low}. Close desktops or delete conversations you no longer need.`;
  if (critical.length) message += ` New conversations wait until ${critical.join(" and ")} ${critical.length > 1 ? "are" : "is"} freed.`;
  return { key: `${memory}/${disk}`, critical: critical.length > 0, message };
}

/** "1.4 GB", "350 MB": desktop sizes in the banner. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}

/** What to show when seeding the browser profile fails. */
export function seedErrorText(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === "browser_running") return "Close the browser in this conversation first";
  return e?.message || String(err);
}
