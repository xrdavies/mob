// What to tell the user about (Settings → Notifications): a conversation on any computer starts
// waiting for them, finishes, or fails. Pure, so node tests run it.
import type { Session } from "../api/types.ts";

export type AlertKind = "needs" | "done" | "failed";

export interface Alert {
  kind: AlertKind;
  machineId: string;
  session: Session;
}

export interface AlertPrefs {
  needs: boolean;
  done: boolean;
  failed: boolean;
  computers: Record<string, "all" | "needs">;
}

/** Last seen state per "machine/session". */
export type Seen = Map<string, { waiting: boolean; active: boolean }>;

/**
 * Compares each computer's conversations with what was seen before and returns the changes worth an
 * alert. Conversations seen for the first time (a computer just loaded) alert nothing. Updates `seen`.
 */
export function alertsFor(seen: Seen, lists: { machineId: string; sessions: Session[] }[], prefs: AlertPrefs): Alert[] {
  const out: Alert[] = [];
  for (const { machineId, sessions } of lists) {
    const level = prefs.computers[machineId] ?? "all";
    for (const s of sessions) {
      const key = `${machineId}/${s.id}`;
      const now = { waiting: !!s.waiting, active: !!s.activeTaskId };
      const before = seen.get(key);
      seen.set(key, now);
      if (!before) continue;
      let kind: AlertKind | null = null;
      if (now.waiting && !before.waiting) kind = "needs";
      else if (before.active && !now.active && s.status === "succeeded") kind = "done";
      else if (before.active && !now.active && s.status === "failed") kind = "failed";
      if (!kind || !prefs[kind] || (level === "needs" && kind !== "needs")) continue;
      out.push({ kind, machineId, session: s });
    }
  }
  return out;
}
