// Every computer's conversations in the sidebar (docs/desktop-redesign D2, D4): the open computer's come
// from the Chat controller; the others' from GET /sessions kept current by their /events stream.
// Pure, so node tests run it.
import type { Session } from "../api/types.ts";

const byUpdated = (a: Session, b: Session) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");

/** A session summary from /events: replaces or adds it (newest first); an archived one leaves the list. */
export function applySessionEvent(list: Session[] | undefined, s: Session): Session[] {
  const rest = (list ?? []).filter((x) => x.id !== s.id);
  if (s.archived) return rest;
  return [...rest, s].sort(byUpdated);
}

export function removeSession(list: Session[] | undefined, id: string): Session[] {
  return (list ?? []).filter((x) => x.id !== id);
}

/**
 * What the sidebar shows for a computer: pinned ones, then the newest, `limit` in all unless expanded;
 * a conversation that needs the user or is open is always shown. `hidden` is how many are under
 * "Show N more".
 */
export function visibleSessions(list: Session[], limit: number, expanded: boolean, openId?: string | null): { shown: Session[]; hidden: number } {
  if (expanded || list.length <= limit) return { shown: list, hidden: 0 };
  const keep = new Set<string>();
  for (const s of list) if (s.pinned || s.waiting || s.id === openId) keep.add(s.id);
  for (const s of list) {
    if (keep.size >= limit) break;
    keep.add(s.id);
  }
  const shown = list.filter((s) => keep.has(s.id));
  return { shown, hidden: list.length - shown.length };
}

export interface Waiting {
  machineId: string;
  session: Session;
}

/** Conversations waiting for the user across computers, the longest waiting first. */
export function needsYou(byMachine: { machineId: string; sessions: Session[] }[]): Waiting[] {
  const out: Waiting[] = [];
  for (const m of byMachine) for (const s of m.sessions) if (s.waiting && !s.archived) out.push({ machineId: m.machineId, session: s });
  return out.sort((a, b) => (a.session.updatedAt ?? "").localeCompare(b.session.updatedAt ?? ""));
}

/** The one-line status under a conversation's title. */
export function sessionLine(s: Session, queuePosition?: number): { tone: "needs" | "working" | "queued" | "failed" | "done"; text: string } {
  if (s.waiting) return { tone: "needs", text: "Needs you" };
  if (s.activeTaskId && s.status === "running") return { tone: "working", text: "Working" };
  if (s.activeTaskId && s.status === "queued") return { tone: "queued", text: queuePosition ? `Queued #${queuePosition}` : "Queued" };
  if (s.status === "failed") return { tone: "failed", text: "Failed" };
  return { tone: "done", text: "Done" };
}
