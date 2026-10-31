import type { Activity, ChatMessage, Question, Session, SessionDetail, Task } from "../api/types.ts";

// The local copy of conversations and paging (docs/conversation-history.md).

/** One turn as saved: the task with its messages, steps and questions. */
export interface StoredTurn {
  task: Task;
  messages: ChatMessage[];
  activities: Activity[];
  questions: Question[];
  /** mobd's cursor naming this turn, when it was the oldest of a page. */
  cursor?: string;
}

export interface SavedConversation {
  session: Session;
  syncRev: number;
  /** The oldest saved turn and the cursor for the page before it. */
  oldest: number | null;
  cursor: string | null;
  /** The newest turns asked for, oldest first. */
  turns: StoredTurn[];
}

/** The local copy; keyed by machine (its serverId) and conversation. */
export interface HistoryStore {
  /** The newest `limit` saved turns older than `before` (null: the newest); null when not saved. */
  load(machine: string, id: string, before: number | null, limit: number): Promise<SavedConversation | null>;
  list(machine: string): Promise<Session[]>;
  /** `replace` drops the conversation's other turns; `keep` names conversations never evicted. */
  save(machine: string, session: Session, syncRev: number, turns: StoredTurn[], replace: boolean, keep: string[]): Promise<void>;
  /** One conversation, or the machine's whole copy. */
  remove(machine: string, id?: string): Promise<void>;
  /** Deletes the machine's conversations missing from `ids`. */
  prune(machine: string, ids: string[]): Promise<void>;
  clear(): Promise<void>;
  size(): Promise<number>;
}

/** The session row as saved: without the messages, which live with their turns. */
export function sessionRow(session: Session): Session {
  const { messages: _, ...row } = session;
  return row;
}

/** The turns of `detail` (all, or those named), in its order. */
export function splitTurns(detail: SessionDetail, ids?: Set<string>): StoredTurn[] {
  const of = <T extends { taskId: string }>(list: T[] = []) => {
    const map = new Map<string, T[]>();
    for (const x of list) map.set(x.taskId, [...(map.get(x.taskId) ?? []), x]);
    return map;
  };
  const messages = of(detail.session.messages);
  const activities = of(detail.activities);
  const questions = of(detail.questions);
  return detail.tasks.filter((t) => !ids || ids.has(t.id)).map((task) => ({
    task, messages: messages.get(task.id) ?? [], activities: activities.get(task.id) ?? [], questions: questions.get(task.id) ?? [],
  }));
}

/** Saved turns as a conversation, with `session`'s metadata. */
export function joinTurns(session: Session, turns: StoredTurn[], rev?: number): SessionDetail {
  return {
    session: { ...session, messages: turns.flatMap((t) => t.messages) },
    tasks: turns.map((t) => t.task),
    activities: turns.flatMap((t) => t.activities),
    questions: turns.flatMap((t) => t.questions),
    rev,
  };
}

/** The lowest `seq` in `detail`, or null without turns. */
export function oldestSeq(detail: SessionDetail): number | null {
  const seqs = detail.tasks.map((t) => t.seq).filter((s): s is number => typeof s === "number");
  return seqs.length ? Math.min(...seqs) : null;
}

/**
 * `d`'s turns merged into `base` by task ID, keeping the copy with the higher `rev`. A turn not
 * held yet joins only when its `seq` is at least `from`, so a changed turn older than the held
 * range never lands at the end as the current one. Turns are ordered by `seq`; the session
 * metadata comes from `d` and the revision stays `base`'s (callers set it).
 */
export function mergeTurns(base: SessionDetail | null, d: SessionDetail, from: number): SessionDetail {
  const held = new Map((base?.tasks ?? []).map((t) => [t.id, t]));
  const fresh = new Set<string>();
  for (const t of d.tasks) {
    const old = held.get(t.id);
    if (old ? (old.rev ?? 0) > (t.rev ?? 0) : (t.seq ?? from) < from) continue;
    fresh.add(t.id);
  }
  const mine = base ? splitTurns(base).filter((t) => !fresh.has(t.task.id)) : [];
  const turns = [...mine, ...splitTurns(d, fresh)];
  turns.sort((a, b) => (a.task.seq ?? 0) - (b.task.seq ?? 0));
  return joinTurns(d.session, turns, base?.rev);
}

/** The HistoryStore without a backend (browser preview and tests): in memory, never evicts. */
export class MemoryHistory implements HistoryStore {
  private data = new Map<string, { session: Session; syncRev: number; turns: Map<string, StoredTurn> }>();

  private key = (machine: string, id: string) => `${machine}\n${id}`;

  async load(machine: string, id: string, before: number | null, limit: number): Promise<SavedConversation | null> {
    const c = this.data.get(this.key(machine, id));
    if (!c) return null;
    const all = [...c.turns.values()].sort((a, b) => (a.task.seq ?? 0) - (b.task.seq ?? 0));
    const turns = all.filter((t) => before === null || (t.task.seq ?? 0) < before).slice(-limit);
    return { session: c.session, syncRev: c.syncRev, oldest: all[0]?.task.seq ?? null, cursor: all[0]?.cursor ?? null, turns: structuredClone(turns) };
  }

  async list(machine: string): Promise<Session[]> {
    return [...this.data.entries()].filter(([k]) => k.startsWith(`${machine}\n`)).map(([, c]) => c.session);
  }

  async save(machine: string, session: Session, syncRev: number, turns: StoredTurn[], replace: boolean): Promise<void> {
    const key = this.key(machine, session.id);
    const c = this.data.get(key) ?? { session, syncRev, turns: new Map() };
    c.session = sessionRow(session);
    c.syncRev = syncRev;
    if (replace) c.turns.clear();
    for (const t of turns) {
      const old = c.turns.get(t.task.id);
      if (old && (old.task.rev ?? 0) > (t.task.rev ?? 0)) continue;
      c.turns.set(t.task.id, structuredClone({ ...t, cursor: t.cursor ?? old?.cursor }));
    }
    this.data.set(key, c);
  }

  async remove(machine: string, id?: string): Promise<void> {
    for (const k of [...this.data.keys()]) {
      if (id ? k === this.key(machine, id) : k.startsWith(`${machine}\n`)) this.data.delete(k);
    }
  }

  async prune(machine: string, ids: string[]): Promise<void> {
    for (const s of await this.list(machine)) if (!ids.includes(s.id)) await this.remove(machine, s.id);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  async size(): Promise<number> {
    return JSON.stringify([...this.data.values()].map((c) => [c.session, [...c.turns.values()]])).length;
  }
}
