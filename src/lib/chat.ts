import type {
  Activity, ChatMessage, HistoryAnswer, Queue, Question, Session, SessionDetail, Task, TaskEvent, TaskStatus, TurnOptions,
} from "../api/types.ts";
import { ApiError, authFetch, streamAuth, UnauthorizedError } from "./auth.ts";
import {
  joinTurns, MemoryHistory, mergeTurns, oldestSeq, splitTurns, type HistoryStore, type StoredTurn,
} from "./history.ts";
import { EventStream, type StreamEvent, type StreamOptions } from "./sse.ts";

export type { Activity, ChatMessage, Question, Session, Task, TaskStatus };

const EVENT_TYPES = ["status", "message", "resume", "activity", "question", "usage", "log", "progress", "error"];

/** The part of EventStream the chat uses; tests substitute a fake. */
export interface ChatStream {
  addEventListener(type: string, listener: (ev: StreamEvent) => void): void;
  onerror: ((err?: unknown) => void) | null;
  close(): void;
}

export type StreamFactory = (url: string, options: StreamOptions) => ChatStream;

/** Turns per history page, from mobd or the local copy. */
const PAGE = 20;

/** Whether the visible conversation is in step with mobd (see docs/conversation-history.md). */
export type SyncState = "" | "syncing" | "offline" | "failed";

/** fetch rejects with a TypeError when mobd cannot be reached at all. */
export function unreachable(err: unknown): boolean {
  return err instanceof TypeError;
}

/** A sync result before it is applied: the conversation to show and the turns to save. */
interface Synced {
  detail: SessionDetail;
  turns: StoredTurn[];
  replace: boolean;
  storedFrom: number | null;
  before: string | null;
}

export function terminal(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/**
 * `d` applied to `base`: a full answer replaces it; a partial one (`full: false`) replaces only
 * the turns it carries, with their messages, steps and questions, and keeps the rest.
 */
export function mergeDetail(base: SessionDetail | null, d: SessionDetail): SessionDetail {
  if (d.full !== false || !base || base.session.id !== d.session.id) return d;
  const tasks = [...base.tasks];
  for (const t of d.tasks) {
    const i = tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) tasks[i] = t;
    else tasks.push(t);
  }
  const changed = new Set(d.tasks.map((t) => t.id));
  const known = new Set(tasks.map((t) => t.id));
  // Kept in turn order, so a changed older turn stays in its place.
  const pick = <T extends { taskId: string }>(old: T[] = [], fresh: T[] = []): T[] => {
    const byTurn = new Map<string, T[]>();
    for (const x of [...old.filter((x) => !changed.has(x.taskId)), ...fresh]) {
      byTurn.set(x.taskId, [...(byTurn.get(x.taskId) ?? []), x]);
    }
    return [...tasks.flatMap((t) => byTurn.get(t.id) ?? []), ...old.filter((x) => !known.has(x.taskId))];
  };
  return {
    session: { ...d.session, messages: pick(base.session.messages, d.session.messages) },
    tasks, activities: pick(base.activities, d.activities), questions: pick(base.questions, d.questions),
    rev: d.rev ?? base.rev, full: true,
  };
}

// Owns one visible conversation. Requests for a previous selection cannot replace it.
export class Chat {
  machineId = "";
  sessions: Session[] = [];
  sessionId: string | null = null;
  session: Session | null = null;
  tasks: Task[] = [];
  activities: Activity[] = [];
  questions: Question[] = [];
  ready = false;
  loading = false;
  submitting = false;
  cancelling = false;
  error = "";
  sync: SyncState = "";
  olderLoading = false;
  olderError = "";

  private url = "";
  /** Office mobd serves paged history ("sessionHistory"); only then is the local copy used. */
  private history = false;
  /** The local copy's machine key (the serverId from pairing). */
  private key = "";
  /** The conversation list came from mobd, not the local copy. */
  private listed = false;
  /** The visible conversation's oldest saved turn, and mobd's cursor for the page before it. */
  private storedFrom: number | null = null;
  private before: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private store: HistoryStore;
  private revision = 0;
  /** mobd's revision of the visible conversation; undefined from mobd versions without it. */
  private rev: number | undefined;
  /** Recently opened conversations on this machine, oldest first: reopening one shows it at once. */
  private cache = new Map<string, SessionDetail>();
  private source: ChatStream | null = null;
  private cursor = 0;
  private recovering: number | null = null;
  private changed: () => void;
  private log: (line: string) => void;
  private stream: StreamFactory;

  constructor(changed: () => void, log: (line: string) => void, stream: StreamFactory = (url, o) => new EventStream(url, o),
    store: HistoryStore = new MemoryHistory()) {
    this.changed = changed;
    this.log = log;
    this.stream = stream;
    this.store = store;
  }

  get baseUrl(): string {
    return this.url;
  }

  get currentTask(): Task | null {
    return this.tasks[this.tasks.length - 1] ?? null;
  }

  get busy(): boolean {
    return !!this.currentTask && !terminal(this.currentTask.status);
  }

  get canSend(): boolean {
    return this.ready && !this.loading && !this.submitting && !this.busy && !this.error && this.sync !== "offline";
  }

  /** Turns before the oldest shown one exist, saved or on mobd. */
  get hasOlder(): boolean {
    return this.history && (this.tasks[0]?.seq ?? 1) > 1;
  }

  /** `key` names the machine's local copy: its serverId, so every address shares one. */
  async setMachine(id: string, url: string, saved?: string | null, key = id): Promise<void> {
    this.machineId = id;
    this.url = url.replace(/\/$/, "");
    this.key = key;
    this.history = false;
    this.listed = false;
    this.sync = "";
    this.sessions = [];
    this.ready = false;
    this.newChat();
    this.cache.clear();
    const revision = this.revision;
    this.loading = true;
    this.changed();
    try {
      const [, history] = await Promise.all([this.list(revision), this.probe()]);
      if (revision !== this.revision) return;
      this.history = !!history;
      this.prune();
      this.ready = true;
      this.loading = false;
      await this.select(saved);
    } catch (err) {
      if (revision !== this.revision) return;
      this.loading = false;
      // Unreachable: the conversations saved on this device can still be read.
      const local = unreachable(err) ? await this.store.list(key).catch(() => []) : [];
      if (revision !== this.revision) return;
      if (!local.length) return this.fail(err);
      this.log(`mobd unreachable; showing ${local.length} saved conversations`);
      this.history = true;
      this.sessions = local.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      this.ready = true;
      this.sync = "offline";
      await this.select(saved);
    }
  }

  private async select(saved?: string | null): Promise<void> {
    const selected = saved === null ? null :
      this.sessions.find((s) => s.id === saved)?.id ?? this.sessions[0]?.id;
    if (selected) await this.open(selected);
    else this.changed();
  }

  /** Whether mobd serves paged history; null when /health did not answer. */
  private async probe(): Promise<boolean | null> {
    try {
      const health = await this.request<{ features?: string[] }>(`${this.url}/health`);
      return !!health.features?.includes("sessionHistory");
    } catch {
      return null;
    }
  }

  /** Conversations deleted on mobd while this device was away leave the local copy too. */
  private prune(): void {
    if (!this.history) return;
    const key = this.key;
    const ids = this.sessions.map((s) => s.id);
    this.writes = this.writes.then(() => this.store.prune(key, ids)).catch((err) => this.log(`pruning the local copy failed: ${String(err)}`));
  }

  /** Leaves the machine: no requests until setMachine (e.g. while it needs pairing). */
  detach(): void {
    this.machineId = "";
    this.url = "";
    this.history = false;
    this.sync = "";
    this.sessions = [];
    this.ready = false;
    this.newChat();
    this.cache.clear();
  }

  newChat(): void {
    this.remember();
    this.revision++;
    this.stop();
    this.cursor = 0;
    this.sessionId = null;
    this.session = null;
    this.rev = undefined;
    this.tasks = [];
    this.activities = [];
    this.questions = [];
    this.error = "";
    this.loading = false;
    this.cancelling = false;
    this.changed();
  }

  async open(id: string): Promise<void> {
    this.remember();
    const revision = ++this.revision;
    this.stop();
    this.cursor = 0;
    this.sessionId = id;
    this.session = null;
    this.rev = undefined;
    this.tasks = [];
    this.activities = [];
    this.questions = [];
    this.storedFrom = null;
    this.before = null;
    this.olderLoading = false;
    this.olderError = "";
    const cached = this.history ? undefined : this.cache.get(id);
    if (cached) this.apply(cached);
    this.error = "";
    this.loading = !cached;
    this.cancelling = false;
    this.changed();
    try {
      if (this.history) {
        // The saved copy shows at once; then only what changed since it is fetched.
        const saved = await this.store.load(this.key, id, null, PAGE).catch((err) => {
          this.log(`reading the local copy failed: ${String(err)}`);
          return null;
        });
        if (revision !== this.revision) return;
        if (saved?.turns.length) {
          this.apply(joinTurns(saved.session, saved.turns, saved.syncRev || undefined));
          this.storedFrom = saved.oldest;
          this.before = saved.cursor;
          this.loading = false;
        }
        this.sync = "syncing";
        this.changed();
        const synced = await this.fetchHistory(id);
        if (revision !== this.revision) return;
        this.applySynced(synced);
      } else {
        const detail = mergeDetail(this.snapshot(), await this.detail(id, this.rev));
        if (revision !== this.revision) return;
        this.apply(detail);
      }
      this.loading = false;
      this.changed();
      this.subscribe();
    } catch (err) {
      if (revision === this.revision) {
        this.loading = false;
        this.syncFailed(err);
      }
    }
  }

  /** Loads the turns before the oldest shown one: from the local copy, else from mobd. */
  async loadOlder(): Promise<void> {
    const first = this.tasks[0];
    const session = this.session;
    if (!this.hasOlder || this.olderLoading || !session || !first?.seq) return;
    const revision = this.revision;
    const from = first.seq;
    this.olderLoading = true;
    this.olderError = "";
    this.changed();
    try {
      let page: SessionDetail | null = null;
      if (this.storedFrom !== null && this.storedFrom < from) {
        const saved = await this.store.load(this.key, session.id, from, PAGE).catch(() => null);
        if (saved?.turns.length) page = joinTurns(session, saved.turns);
      }
      if (!page) {
        if (!this.before) throw new Error("mobd gave no cursor for older messages.");
        const answer = await this.historyRequest(session.id, `before=${encodeURIComponent(this.before)}&limit=${PAGE}`);
        if (revision !== this.revision) return;
        const turns = splitTurns(answer);
        if (answer.before && turns.length) turns[0].cursor = answer.before;
        this.storedFrom = oldestSeq(answer);
        this.before = answer.before ?? null;
        page = { ...answer, session: { ...session, messages: answer.session.messages } };
        this.save(turns);
      }
      if (revision !== this.revision) return;
      // Older pages never move the sync baseline.
      const merged = mergeTurns(this.snapshot(), page, oldestSeq(page) ?? from);
      merged.rev = this.rev;
      this.apply(merged);
    } catch (err) {
      if (revision !== this.revision) return;
      this.log(`loading older turns failed: ${String(err)}`);
      this.olderError = unreachable(err) ? "Older messages aren't available offline" : "Couldn't load older messages";
    } finally {
      if (revision === this.revision) {
        this.olderLoading = false;
        this.changed();
      }
    }
  }

  /** Returning to the app: catches up with what changed meanwhile. */
  resync(): void {
    if (!this.history || !this.sessionId || this.sync === "syncing" || this.recovering !== null) return;
    if (!this.listed) void this.refresh();
    else void this.recover(this.revision, true);
  }

  /** Retry after "Couldn't sync" or "Offline". */
  retrySync(): void {
    if (!this.listed) void this.refresh();
    else if (this.sessionId) void this.recover(this.revision, true);
  }

  async refresh(): Promise<void> {
    const revision = this.revision;
    try {
      // After starting offline, /health tells whether mobd still serves paged history.
      const [, history] = await Promise.all([this.list(revision), this.listed ? null : this.probe()]);
      if (revision !== this.revision) return;
      if (history !== null) this.history = history;
      this.prune();
      if (this.sync === "offline") this.sync = "";
      this.ready = true;
      if (this.sessionId) await this.open(this.sessionId);
      else {
        this.error = "";
        this.changed();
      }
    } catch (err) {
      if (revision === this.revision) this.fail(err);
    }
  }

  async submit(prompt: string, options: TurnOptions = {}): Promise<boolean> {
    if (!this.canSend || !prompt.trim()) return false;
    const revision = ++this.revision;
    const url = this.url;
    const sessionId = this.sessionId;
    this.submitting = true;
    this.error = "";
    this.changed();
    try {
      const t = await this.request<Task>(`${url}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt, sessionId: sessionId ?? undefined, runner: sessionId ? undefined : options.runner || undefined,
          model: options.model || undefined,
          effort: options.effort || undefined, attachments: options.attachments?.length ? options.attachments : undefined,
        }),
      });
      if (!t.sessionId) throw new Error("Update office mobd to support chat sessions.");
      this.log(`created turn ${t.id} in session ${t.sessionId}`);
      if (revision !== this.revision) return false;
      this.sessionId = t.sessionId;
      this.session = {
        ...(this.session ?? { id: t.sessionId, title: prompt, status: t.status }),
        activeTaskId: t.id,
        status: t.status,
        messages: [...(this.session?.messages ?? []), {
          id: `${t.id}:user`, taskId: t.id, role: "user", content: prompt, createdAt: new Date().toISOString(),
        }],
      };
      this.tasks = [...this.tasks, t];
      const previous = this.sessions.find((s) => s.id === t.sessionId);
      this.sessions = [{ ...previous, id: t.sessionId, title: this.session.title, status: t.status, activeTaskId: t.id,
        updatedAt: t.createdAt ?? new Date().toISOString() }, ...this.sessions.filter((s) => s.id !== t.sessionId)];
      this.cursor = t.eventId;
      this.changed();
      this.saveCurrent();
      this.subscribe();
      // The POST acknowledgement is enough to clear the composer; history recovers separately.
      void this.recover(revision);
      return true;
    } catch (err) {
      if (revision === this.revision) this.fail(err);
      return false;
    } finally {
      this.submitting = false;
      this.changed();
    }
  }

  async cancel(): Promise<void> {
    const t = this.currentTask;
    if (!t || !this.busy || this.cancelling) return;
    const revision = this.revision;
    this.cancelling = true;
    this.changed();
    try {
      await this.request(`${this.url}/tasks/${t.id}/cancel`, { method: "POST" });
      this.log(`cancel requested for ${t.id}`);
      // SSE releases the composer only when the runner has actually stopped.
    } catch (err) {
      if (revision === this.revision) {
        this.cancelling = false;
        this.fail(err);
      }
    }
  }

  /** Adds a message to the running turn (runners that support steering). */
  async steer(text: string): Promise<boolean> {
    const t = this.currentTask;
    if (!t || t.status !== "running" || !text.trim()) return false;
    try {
      await this.request(`${this.url}/tasks/${t.id}/steer`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: text }),
      });
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /** Questions still waiting for the user, oldest first. */
  get pendingQuestions(): Question[] {
    return this.questions.filter((q) => q.status === "pending");
  }

  /** Sends the user's answer (or approval decision) for a pending question. */
  async answer(q: Question, reply: { answer?: string; approved?: boolean }): Promise<boolean> {
    try {
      const updated = await this.request<Question>(`${this.url}/tasks/${q.taskId}/questions/${q.id}/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reply),
      });
      this.upsertQuestion(updated);
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  private upsertQuestion(q: Question): void {
    const i = this.questions.findIndex((x) => x.id === q.id);
    this.questions = i >= 0 ? this.questions.map((x, j) => (j === i ? q : x)) : [...this.questions, q];
    const waiting = this.questions.some((x) => x.taskId === q.taskId && x.status === "pending");
    const task = this.tasks.find((t) => t.id === q.taskId);
    if (task) task.waiting = waiting;
    if (this.session && this.currentTask?.id === q.taskId) this.session.waiting = waiting;
    const summary = this.sessions.find((s) => s.id === this.sessionId);
    if (summary && this.currentTask?.id === q.taskId) summary.waiting = waiting;
    this.changed();
  }

  /** Applies a session summary from the global event stream. */
  applySession(summary: Session): void {
    if (!this.ready) return;
    const existing = this.sessions.find((s) => s.id === summary.id);
    const merged = { ...existing, ...summary, messages: undefined };
    this.sessions = [merged, ...this.sessions.filter((s) => s.id !== summary.id)];
    if (this.session?.id === summary.id) {
      this.session = { ...this.session, title: summary.title, pinned: summary.pinned, archived: summary.archived, model: summary.model, effort: summary.effort };
    }
    this.changed();
  }

  removeSession(id: string): void {
    if (this.history) {
      const key = this.key;
      this.writes = this.writes.then(() => this.store.remove(key, id)).catch((err) => this.log(`removing the local copy failed: ${String(err)}`));
    }
    if (!this.sessions.some((s) => s.id === id) && this.sessionId !== id) return;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessionId === id) this.newChat();
    else this.changed();
    this.cache.delete(id);
  }

  /** Keeps the visible turn's queue position (and why it waits) current. */
  applyQueue(queue: Queue): void {
    const t = this.currentTask;
    if (!t || t.status !== "queued") return;
    const queued = queue.queued.find((q) => q.id === t.id);
    this.applyQueued(t, queued?.queuePosition, queued?.queueReason);
  }

  /** Applies a task snapshot from the global event stream to the visible queued turn. */
  applyTask(task: Task): void {
    const t = this.currentTask;
    if (!t || t.id !== task.id || t.status !== "queued" || task.status !== "queued") return;
    this.applyQueued(t, task.queuePosition, task.queueReason);
  }

  private applyQueued(t: Task, position: Task["queuePosition"], reason: Task["queueReason"]): void {
    if (position === t.queuePosition && reason === t.queueReason) return;
    t.queuePosition = position;
    t.queueReason = reason;
    this.changed();
  }

  async patchSession(id: string, patch: { title?: string; pinned?: boolean; archived?: boolean; model?: string; effort?: string }): Promise<void> {
    try {
      const summary = await this.request<Session>(`${this.url}/sessions/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (summary.archived) this.removeSession(id);
      else this.applySession(summary);
    } catch (err) {
      this.fail(err);
    }
  }

  async deleteSession(id: string): Promise<void> {
    try {
      await this.request(`${this.url}/sessions/${id}`, { method: "DELETE" });
      this.removeSession(id);
    } catch (err) {
      this.fail(err);
    }
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await authFetch(this.url, url, init);
    if (res.status === 404 && url.endsWith("/sessions")) {
      throw new Error("Update office mobd to support chat sessions.");
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json();
    if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status, data.code);
    return data as T;
  }

  private async list(revision: number): Promise<void> {
    const data = await this.request<{ sessions: Session[] }>(`${this.url}/sessions`);
    if (!Array.isArray(data.sessions)) throw new Error("Invalid session list from mobd.");
    if (revision === this.revision) {
      this.sessions = data.sessions;
      this.listed = true;
      this.changed();
    }
  }

  private async historyRequest(id: string, query: string): Promise<HistoryAnswer> {
    const data = await this.request<HistoryAnswer>(`${this.url}/sessions/${id}/history?${query}`);
    if (data.session?.id !== id || (data.tasks != null && !Array.isArray(data.tasks))) {
      throw new Error("Invalid session history from mobd.");
    }
    data.tasks ??= [];
    data.session.messages ??= [];
    return data;
  }

  /**
   * What changed since the saved revision, merged into the visible conversation; without a
   * saved copy, or when mobd answers `reset`, the newest page replaces it.
   */
  private async fetchHistory(id: string): Promise<Synced> {
    if (this.rev && this.tasks.length) {
      const d = await this.historyRequest(id, `since=${this.rev}&limit=50`);
      if (!d.reset) {
        const from = this.tasks[0]?.seq ?? 0;
        const detail = mergeTurns(this.snapshot(), d, from);
        detail.rev = d.rev;
        // A changed turn inside the saved range is saved even when it is not shown yet.
        const low = this.storedFrom ?? from;
        const ids = new Set(d.tasks.filter((t) => (t.seq ?? low) >= low).map((t) => t.id));
        return { detail, turns: splitTurns(d, ids), replace: false, storedFrom: this.storedFrom ?? from, before: this.before };
      }
      this.log("history reset by mobd; loading the newest page");
    }
    const page = await this.historyRequest(id, `limit=${PAGE}`);
    const turns = splitTurns(page);
    if (page.before && turns.length) turns[0].cursor = page.before;
    return { detail: page, turns, replace: true, storedFrom: oldestSeq(page), before: page.before ?? null };
  }

  private applySynced(s: Synced): void {
    this.apply(s.detail);
    this.storedFrom = s.storedFrom;
    this.before = s.before;
    this.sync = "";
    this.save(s.turns, s.replace);
  }

  /** A failed open or sync: a saved copy stays readable; a conversation gone from mobd is removed. */
  private syncFailed(err: unknown): void {
    const id = this.sessionId;
    if (this.history && id && err instanceof ApiError && err.status === 404) {
      this.log(`conversation ${id} is gone from mobd`);
      this.removeSession(id);
      return;
    }
    if (this.history && !(err instanceof UnauthorizedError) && (this.tasks.length || unreachable(err))) {
      this.log(`sync failed: ${String(err)}`);
      this.sync = unreachable(err) ? "offline" : "failed";
      if (!this.tasks.length) this.error = "The office computer is unreachable, and this conversation isn't saved on this device.";
      this.changed();
      return;
    }
    this.fail(err);
  }

  /** Queues a write of `turns` and the session row to the local copy, never blocking the view. */
  private save(turns: StoredTurn[], replace = false): void {
    const session = this.session;
    if (!this.history || !session || (!turns.length && !replace)) return;
    const key = this.key;
    const rev = this.rev ?? 0;
    const keep = [session.id, ...this.sessions.filter((s) => !terminal(s.status)).map((s) => s.id)];
    // Copied now: events keep changing the live objects.
    const data = structuredClone({ session, turns });
    this.writes = this.writes.then(() => this.store.save(key, data.session, rev, data.turns, replace, keep))
      .catch((err) => this.log(`saving the local copy failed: ${String(err)}`));
  }

  /** Saves the current turn now (it finished, or the conversation is left). */
  private saveCurrent(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const s = this.snapshot();
    const t = this.currentTask;
    if (s && t) this.save(splitTurns(s, new Set([t.id])));
  }

  /** While a turn runs, saves it at most every 5 seconds rather than per event. */
  private saveSoon(): void {
    if (!this.history || this.saveTimer) return;
    const revision = this.revision;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (revision === this.revision) this.saveCurrent();
    }, 5000);
  }

  /** With `since`, mobd may answer only the turns changed after that revision (see mergeDetail). */
  private async detail(id: string, since?: number): Promise<SessionDetail> {
    const query = since ? `?since=${since}` : "";
    const data = await this.request<SessionDetail>(`${this.url}/sessions/${id}${query}`);
    if (data.session?.id !== id || !Array.isArray(data.tasks)) {
      throw new Error("Invalid session history from mobd.");
    }
    return data;
  }

  private apply(detail: SessionDetail): void {
    this.session = detail.session;
    this.tasks = detail.tasks;
    this.activities = detail.activities ?? [];
    this.questions = detail.questions ?? [];
    this.rev = detail.rev;
    this.cursor = this.currentTask?.eventId ?? 0;
    if (!this.busy) this.cancelling = false;
  }

  private subscribe(): void {
    const t = this.currentTask;
    if (!t || terminal(t.status)) return;
    this.stop();
    const revision = this.revision;
    const auth = streamAuth(this.url);
    const es = this.stream(`${this.url}/tasks/${t.id}/events?after=${this.cursor}`, {
      ...auth,
      // The reconnect resumes after the last event ID, like Last-Event-ID.
      resumeParam: "after",
      onUnauthorized: () => {
        auth.onUnauthorized();
        if (current()) {
          this.stop();
          this.fail(new UnauthorizedError());
        }
      },
    });
    this.source = es;
    const current = () => this.source === es && this.revision === revision;
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        if (!current()) return;
        if (!ev.data) return;
        try {
          const data = JSON.parse(ev.data) as TaskEvent;
          if (!Number.isSafeInteger(data.id) || data.id <= this.cursor) return;
          const task = this.currentTask;
          if (!task || task.id !== t.id) return;
          this.cursor = data.id;
          task.eventId = data.id;
          this.log(`${type}: ${data.message ?? data.status ?? data.activity?.title ?? ""}`);
          if (type === "activity" && data.activity) {
            const a = data.activity;
            const i = this.activities.findIndex((x) => x.id === a.id);
            this.activities = i >= 0 ? this.activities.map((x, j) => (j === i ? a : x)) : [...this.activities, a];
            this.changed();
          }
          if (type === "question" && data.question) {
            this.upsertQuestion(data.question);
          }
          if (type === "usage" && data.usage) {
            task.usage = data.usage;
            this.changed();
          }
          if (type === "message" && data.messageId && typeof data.message === "string" && this.session) {
            const user = data.role === "user";
            // User messages added mid-turn already carry their full ID.
            const id = user ? data.messageId : `${t.id}:${data.messageId}`;
            const messages = this.session.messages ??= [];
            const existing = messages.find((m) => m.id === id);
            if (existing) existing.content = data.message;
            else messages.push({ id, taskId: t.id, role: user ? "user" : "assistant", content: data.message, createdAt: data.timestamp });
            this.changed();
          }
          if (data.status && this.session) {
            task.status = data.status;
            task.error = data.status === "failed" ? data.message : null;
            if (data.status === "running") {
              task.startedAt ??= data.timestamp;
              task.queuePosition = undefined;
              task.queueReason = undefined;
            }
            if (terminal(data.status)) task.finishedAt ??= data.timestamp;
            this.session.status = data.status;
            const summary = this.sessions.find((s) => s.id === this.sessionId);
            if (summary) summary.status = data.status;
            if (terminal(data.status)) {
              this.session.activeTaskId = undefined;
              this.cancelling = false;
              this.saveCurrent();
              this.stop();
              void this.recover(revision);
            }
            this.changed();
          } else if (type === "error") {
            this.fail(new Error(data.message || "Runner error"));
          }
          if (!terminal(task.status)) this.saveSoon();
        } catch (err) {
          this.log(`event decode failed: ${String(err)}`);
        }
      });
    }
    es.onerror = (raw) => {
      if (!current()) return;
      if (raw && typeof raw === "object" && "data" in raw) return;
      this.log("SSE interrupted; reconnecting and restoring history");
      // The stream reconnects after its last event ID. A snapshot also recovers daemon restarts.
      void this.recover(revision, true);
    };
  }

  /** `indicate` shows "Syncing…" (reconnecting, returning to the app); routine refreshes show nothing. */
  private async recover(revision: number, indicate = false): Promise<void> {
    if (this.recovering === revision || !this.sessionId) return;
    this.recovering = revision;
    const id = this.sessionId;
    if (indicate && this.history) {
      this.sync = "syncing";
      this.changed();
    }
    try {
      const synced = this.history ? await this.fetchHistory(id) : null;
      const detail = synced?.detail ?? mergeDetail(this.snapshot(), await this.detail(id, this.rev));
      if (revision !== this.revision) return;
      const latest = detail.tasks[detail.tasks.length - 1];
      const current = this.currentTask;
      // An in-flight snapshot must not overwrite a newer event already displayed.
      if (!latest || latest.id !== current?.id || latest.eventId >= this.cursor || terminal(latest.status)) {
        const changedTask = latest?.id !== current?.id;
        if (synced) this.applySynced(synced);
        else this.apply(detail);
        this.error = "";
        if (!this.busy) this.stop();
        else if (changedTask || !this.source) this.subscribe();
        this.changed();
      } else if (this.sync === "syncing") {
        this.sync = "";
        this.changed();
      }
      await this.list(revision);
    } catch (err) {
      this.log(`history recovery failed: ${String(err)}`);
      if (this.history && revision === this.revision && !(err instanceof UnauthorizedError)) this.syncFailed(err);
      // A revoked credential ends the conversation view; reconnects would only repeat the 401.
      if (err instanceof UnauthorizedError && revision === this.revision) {
        this.stop();
        this.fail(err);
      }
    } finally {
      if (this.recovering === revision) this.recovering = null;
    }
  }

  /** The visible conversation as held now, or null before it has loaded. */
  private snapshot(): SessionDetail | null {
    if (!this.session || this.session.id !== this.sessionId) return null;
    return { session: this.session, tasks: this.tasks, activities: this.activities, questions: this.questions, rev: this.rev };
  }

  private remember(): void {
    const s = this.snapshot();
    if (!s) return;
    // A pending timer means the running turn changed since it was last saved.
    if (this.history) {
      if (this.saveTimer) this.saveCurrent();
      return;
    }
    this.cache.delete(s.session.id);
    this.cache.set(s.session.id, s);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
  }

  private stop(): void {
    this.source?.close();
    this.source = null;
  }

  private fail(err: unknown): void {
    this.error = err instanceof Error ? err.message : String(err);
    this.log(this.error);
    this.changed();
  }
}
