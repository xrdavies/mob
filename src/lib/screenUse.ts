// Who is acting on a machine's screen (mobd's screenUse events and /health field): agents' desktop
// tools and live view control. Desktop shows it for this computer, where the user may be working.

export interface ScreenUse {
  source: "agent" | "control";
  sessionId?: string;
  taskId?: string;
  clientId?: string;
  active: boolean;
  since: string;
}

const key = (u: ScreenUse) => (u.source === "agent" ? `agent/${u.sessionId ?? ""}` : `control/${u.clientId ?? ""}`);

/** Validates one event or /health entry; anything else is ignored. */
export function parseScreenUse(raw: unknown): ScreenUse | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if ((r.source !== "agent" && r.source !== "control") || typeof r.active !== "boolean") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    source: r.source, active: r.active, since: str(r.since) ?? "",
    sessionId: str(r.sessionId), taskId: str(r.taskId), clientId: str(r.clientId),
  };
}

/** The uses in progress after an event: a start adds or replaces, an end removes. */
export function applyScreenUse(list: ScreenUse[], u: ScreenUse): ScreenUse[] {
  const rest = list.filter((x) => key(x) !== key(u));
  return u.active ? [...rest, u] : rest;
}

/** The indicator's text: agents first (they move the pointer on their own), then remote control. */
export function screenUseText(list: ScreenUse[], title: (sessionId?: string) => string | undefined): string {
  if (!list.length) return "";
  const agent = list.find((u) => u.source === "agent");
  if (agent) {
    const name = title(agent.sessionId);
    const more = list.length > 1 ? ` (+${list.length - 1})` : "";
    return `Agent is using the screen${name ? ` · ${name}` : ""}${more}`;
  }
  return list.length > 1 ? `${list.length} devices are controlling this computer` : "Another device is controlling this computer";
}
