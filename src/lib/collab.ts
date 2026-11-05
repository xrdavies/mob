// Agent collaboration helpers (mobd docs/agent-collaboration-design.md). Pure, so they can be tested
// without the UI: handles, @ mentions in the composer, and delivered peer messages.

import type { Activity, CollabRequest, Delivery, Session } from "@/api/types";

const HANDLE = /^[a-z][a-z0-9-]{1,31}$/;
const HEX = /^[0-9a-f]+$/;
const RESERVED = new Set(["all", "everyone", "here", "user", "me", "mob", "mobd", "system"]);

/** Whether `h` may name an agent: mobd's rules (all-hex reads as a short ID). */
export function validHandle(h: string): boolean {
  return HANDLE.test(h) && !HEX.test(h) && !RESERVED.has(h);
}

/** Why `h` cannot be a handle, in words for the user; "" when it can. */
export function handleProblem(h: string): string {
  if (h.length < 2) return "At least 2 characters.";
  if (h.length > 32) return "At most 32 characters.";
  if (!/^[a-z]/.test(h)) return "Start with a letter.";
  if (!/^[a-z0-9-]+$/.test(h)) return "Use lowercase letters, digits and -.";
  if (HEX.test(h)) return "Only 0–9 and a–f reads as a conversation ID; add another letter.";
  if (RESERVED.has(h)) return `@${h} is reserved.`;
  return "";
}

/** What the handle field keeps of typed text: lowercase, no leading @, spaces as -. */
export const normalizeHandleInput = (s: string) =>
  s.toLowerCase().replace(/^@+/, "").replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 32);

/** A handle suggested from a conversation's title, or "" when none fits or all are taken. */
export function suggestHandle(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "");
  base = base.split("-").filter(Boolean).slice(0, 3).join("-").slice(0, 28).replace(/-+$/, "");
  if (!validHandle(base)) base = validHandle(`${base}-agent`) ? `${base}-agent` : "agent";
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const h = `${base.slice(0, 28)}-${i}`;
    if (validHandle(h) && !used.has(h)) return h;
  }
  return "";
}

/** The `@word` being typed at `caret`, with where it starts, or null. */
export function mentionAt(text: string, caret: number): { query: string; start: number } | null {
  const m = /(^|\s)@([a-z0-9-]*)$/i.exec(text.slice(0, caret));
  if (!m) return null;
  return { query: m[2].toLowerCase(), start: caret - m[2].length - 1 };
}

export const shortId = (id: string) => id.slice(0, 6);

/** An agent's name where space is short: "@handle", else its title cut to `max` characters with a short ID. */
export function agentShortLabel(s: Pick<Session, "id" | "title" | "handle">, max = 32): string {
  if (s.handle) return `@${s.handle}`;
  const t = [...s.title];
  return `${t.length > max ? `${t.slice(0, max - 1).join("").trimEnd()}…` : s.title} (${shortId(s.id)})`;
}

/** How an agent is shown: "@handle" or its title with a short ID. */
export function agentLabel(s: Pick<Session, "id" | "title" | "handle">): string {
  return s.handle ? `@${s.handle}` : `${s.title} (${shortId(s.id)})`;
}

/**
 * Conversations for the @ picker: not `self`; handle prefix matches first, then title words, then
 * short IDs. Archived ones stay in the list (shown greyed, not selectable).
 */
export function mentionCandidates(sessions: Session[], query: string, self: string | null, limit = 8): Session[] {
  const q = query.toLowerCase();
  const score = (s: Session) => {
    if (!q) return s.handle ? 0 : 1;
    if (s.handle?.startsWith(q)) return 0;
    if (s.title.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (q.length >= 4 && s.id.startsWith(q)) return 2;
    return -1;
  };
  return sessions
    .filter((s) => s.id !== self)
    .map((s) => ({ s, k: score(s) }))
    .filter((x) => x.k >= 0)
    .sort((a, b) => a.k - b.k || Number(!!a.s.archived) - Number(!!b.s.archived))
    .slice(0, limit)
    .map((x) => x.s);
}

/** The token a picked agent becomes in the text: its handle, else its short ID. */
export const mentionToken = (s: Pick<Session, "id" | "handle">) => `@${s.handle || shortId(s.id)}`;

/**
 * Mentions in a message to send: every @handle or @short-id that names another conversation.
 * Archived ones are reported (the send stops); words that name nothing stay plain text.
 */
export function resolveMentions(text: string, sessions: Session[], self: string | null): { ids: string[]; archived: string[] } {
  const ids: string[] = [];
  const archived: string[] = [];
  for (const m of text.matchAll(/(^|\s)@([a-z0-9-]{2,32})(?=$|[\s.,;:!?)])/gi)) {
    const word = m[2].toLowerCase();
    let hit = sessions.find((s) => s.handle === word);
    if (!hit && HEX.test(word) && word.length >= 6) {
      const byId = sessions.filter((s) => s.id.startsWith(word));
      if (byId.length === 1) hit = byId[0];
    }
    if (!hit || hit.id === self) continue;
    if (hit.archived) {
      if (!archived.includes(`@${word}`)) archived.push(`@${word}`);
    } else if (!ids.includes(hit.id)) ids.push(hit.id);
  }
  return { ids, archived };
}

/** A delivered collaboration turn's prompt split into its messages: who sent each and the text. */
export function parseDelivery(prompt: string): { from: string; request: string; body: string }[] {
  const out: { from: string; request: string; body: string }[] = [];
  for (const part of prompt.split(/\n\n---\n\n/)) {
    const m = /\[Mob collaboration · from (.+?) · request (\S+) · exchange \S+\]\n([\s\S]*)/.exec(part);
    if (m) out.push({ from: m[1], request: m[2], body: m[3].trim() });
  }
  return out;
}

export type RequestStatus = "open" | "in_progress" | "needs_clarification" | "answered" | "failed" | "cancelled" |
  "expired" | "interrupted" | "over_budget";

export const requestEnded = (s: RequestStatus) => !["open", "in_progress", "needs_clarification"].includes(s);
/** Ended without an outcome: the user should look. */
export const needsUser = (s: RequestStatus) => s === "interrupted" || s === "over_budget" || s === "expired";

export const statusLabel: Record<RequestStatus, string> = {
  open: "waiting", in_progress: "handling", needs_clarification: "needs clarification", answered: "answered",
  failed: "failed", cancelled: "cancelled", expired: "expired · needs you", interrupted: "interrupted · needs you",
  over_budget: "out of turns · needs you",
};

/** Text split into plain runs and @mentions of other conversations (handle or short ID), for highlighting. */
export function mentionSegments(text: string, sessions: Session[], self: string | null): { text: string; session?: Session }[] {
  const out: { text: string; session?: Session }[] = [];
  let last = 0;
  for (const m of text.matchAll(/(^|\s)@([a-z0-9-]{2,32})(?=$|[\s.,;:!?)])/gi)) {
    const word = m[2].toLowerCase();
    let hit = sessions.find((s) => s.handle === word);
    if (!hit && HEX.test(word) && word.length >= 6) {
      const byId = sessions.filter((s) => s.id.startsWith(word));
      if (byId.length === 1) hit = byId[0];
    }
    if (!hit || hit.id === self) continue;
    const start = m.index + m[1].length;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: `@${m[2]}`, session: hit });
    last = start + m[2].length + 1;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Who a delivery is from, by session ID: the requester for requests and answers, else the recipient. */
export function deliverySender(d: Pick<Delivery, "kind">, r: Pick<CollabRequest, "from" | "to">): string | null {
  if (d.kind === "notice") return null;
  return d.kind === "request" || d.kind === "answer" ? r.from : r.to;
}

/** What a delivery says about itself, as a short label after the sender's name. */
export function deliveryLabel(d: Pick<Delivery, "kind">, r?: Pick<CollabRequest, "status">): string {
  switch (d.kind) {
    case "request": return "asks";
    case "clarification": return "needs clarification";
    case "answer": return "answered your question";
    case "result": return r?.status === "failed" ? "couldn't complete your request" : "replied";
    default: return "";
  }
}

/**
 * The part of a delivered message an agent's sender wrote, without mobd's instructions to the
 * recipient (for turns without structured deliveries).
 */
export function deliveryBody(body: string): string {
  return body
    .replace(/^Request: /, "")
    .replace(/\n\nWhen done, call complete_request\([\s\S]*$/, "")
    .replace(/\n\nAnswer with answer_clarification\([\s\S]*$/, "")
    .replace(/^Result of your request "(?:[^"\\]|\\.)*" to .+? \((\w+)\):\n/, "")
    .trim();
}

/** A readable title for a collaboration tool step, or null for other steps. */
export function collabStepTitle(a: Pick<Activity, "server" | "tool" | "arguments">, sessions: Session[] = []): string | null {
  if (a.server !== "mob-mcp") return null;
  const arg = (k: string) => (typeof a.arguments?.[k] === "string" ? (a.arguments[k] as string) : "");
  const to = arg("to").replace(/^@/, "").toLowerCase();
  const byId = to.length >= 6 && HEX.test(to) ? sessions.filter((s) => s.id.startsWith(to)) : [];
  const hit = sessions.find((s) => s.handle === to) ?? (byId.length === 1 ? byId[0] : undefined);
  const who = hit ? agentShortLabel(hit) : !to ? "an agent" : HEX.test(to) ? to : `@${to}`;
  switch (a.tool) {
    case "send_request": return `Asked ${who}: ${arg("request")}`;
    case "ask_clarification": return `Asked for clarification: ${arg("text")}`;
    case "answer_clarification": return `Answered the clarification: ${arg("text")}`;
    case "complete_request": return arg("outcome") === "failed" ? `Reported it couldn't: ${arg("result")}` : `Replied: ${arg("result")}`;
    case "list_collaborators": return "Looked up the mentioned agents";
    default: return null;
  }
}
