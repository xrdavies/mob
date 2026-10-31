import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
// Node runs the erasable TypeScript modules directly (type stripping).
import { Chat } from "./chat.ts";
import { joinTurns, MemoryHistory, mergeTurns, splitTurns } from "./history.ts";

const task = (seq, rev, status = "succeeded") =>
  ({ id: `t${seq}`, sessionId: "s", seq, rev, status, eventId: 1, runner: "codex", prompt: `p${seq}` });
const message = (t) => ({ id: `${t.id}:a`, taskId: t.id, role: "assistant", content: `reply ${t.seq} r${t.rev}` });
const conversation = (tasks, rev) => ({
  session: { id: "s", title: "s", status: "succeeded", messages: tasks.map(message) }, tasks,
  activities: tasks.map((t) => ({ id: `${t.id}:1`, taskId: t.id, kind: "tool", status: "completed", title: t.id })),
  questions: [], rev,
});
const replies = (chat) => chat.session.messages.map((m) => m.content);

test("merging keeps the higher rev, orders by seq and never appends an older turn", () => {
  const base = conversation([task(3, 3), task(4, 4)], 4);
  const d = mergeTurns(base, conversation([task(4, 9), task(2, 8), task(5, 9, "running")], 9), 3);
  assert.deepEqual(d.tasks.map((t) => t.id), ["t3", "t4", "t5"], "t2 lies before the held range");
  assert.deepEqual(d.session.messages.map((m) => m.content), ["reply 3 r3", "reply 4 r9", "reply 5 r9"]);
  assert.deepEqual(d.activities.map((a) => a.taskId), ["t3", "t4", "t5"]);
  assert.equal(d.rev, 4, "callers set the revision");
  const stale = mergeTurns(d, conversation([task(4, 6)], 6), 3);
  assert.equal(stale.session.messages[1].content, "reply 4 r9", "a lower rev does not replace a turn");
  const older = mergeTurns(d, conversation([task(1, 1), task(2, 8)], 9), 1);
  assert.deepEqual(older.tasks.map((t) => t.id), ["t1", "t2", "t3", "t4", "t5"]);
  assert.deepEqual(joinTurns(d.session, splitTurns(d)).tasks, d.tasks);
});

test("the memory copy pages saved turns and keeps cursors and newer turns", async () => {
  const store = new MemoryHistory();
  const turns = splitTurns(conversation([task(2, 2), task(3, 3), task(4, 4)], 4));
  turns[0].cursor = "c2";
  await store.save("m", { id: "s", title: "s", status: "succeeded" }, 4, turns, true, []);
  await store.save("m", { id: "s", title: "s", status: "succeeded" }, 5, splitTurns(conversation([task(2, 1)], 5)), false, []);
  const saved = await store.load("m", "s", null, 2);
  assert.deepEqual([saved.syncRev, saved.oldest, saved.cursor], [5, 2, "c2"]);
  assert.deepEqual(saved.turns.map((t) => t.task.seq), [3, 4]);
  assert.deepEqual((await store.load("m", "s", 3, 9)).turns.map((t) => t.messages[0].content), ["reply 2 r2"]);
  await store.prune("m", []);
  assert.equal(await store.load("m", "s", null, 2), null);
});

/** A mobd with sessionHistory and one conversation of `count` turns. */
function office(count) {
  const session = { id: "s", title: "s", status: "succeeded", updatedAt: "2026-10-01T00:00:00Z" };
  const tasks = Array.from({ length: count }, (_, i) => task(i + 1, i + 1));
  const state = { rev: count, offline: false, gone: false, reset: false, gate: null };
  const answer = (list, extra) => ({
    session: { ...session, turns: tasks.length, rev: state.rev, messages: list.map(message) },
    tasks: list.map((t) => ({ ...t })), activities: [], questions: [], rev: state.rev, ...extra,
  });
  async function handle(url) {
    if (state.offline) throw new TypeError("fetch failed");
    if (url.endsWith("/health")) return { apiVersion: 3, features: ["sessionHistory"] };
    if (url.endsWith("/sessions")) return { sessions: state.gone ? [] : [session] };
    if (state.gone) return { statusCode: 404, body: { error: "session not found" } };
    const u = new URL(url);
    assert.match(u.pathname, /\/sessions\/s\/history$/, `unexpected ${url}`);
    if (state.gate) await state.gate;
    const limit = Number(u.searchParams.get("limit"));
    if (u.searchParams.has("since")) {
      const since = Number(u.searchParams.get("since"));
      if (state.reset || since === 0 || since > state.rev) return answer([], { reset: true });
      return answer(tasks.filter((t) => t.rev > since || t.status === "running"), { reset: false });
    }
    const before = u.searchParams.has("before") ? Number(u.searchParams.get("before").slice(1)) : Infinity;
    const older = tasks.filter((t) => t.seq < before);
    const list = older.slice(-limit);
    const hasMore = older.length > list.length;
    return answer(list, { hasMore, ...(hasMore ? { before: `c${list[0].seq}` } : {}) });
  }
  return {
    state, handle,
    change(seq) { tasks[seq - 1].rev = ++state.rev; },
    add() { tasks.push(task(tasks.length + 1, ++state.rev)); },
  };
}

function harness(t, mobd, store = new MemoryHistory()) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    const result = await mobd.handle(url);
    return new Response(JSON.stringify(result.body ?? result), { status: result.statusCode ?? 200 });
  });
  const chat = new Chat(() => {}, () => {}, () => ({ addEventListener() {}, onerror: null, close() {} }), store);
  t.after(() => chat.newChat());
  return { chat, calls, store };
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await setImmediate();
};

test("opens on the newest page and loads older pages without gaps or duplicates", async (t) => {
  const mobd = office(45);
  const { chat, calls } = harness(t, mobd);
  await chat.setMachine("office", "http://office", "s", "server-1");
  assert.match(calls.at(-1), /\/sessions\/s\/history\?limit=20$/);
  assert.deepEqual([chat.tasks[0].seq, chat.currentTask.seq, chat.hasOlder], [26, 45, true]);
  await chat.loadOlder();
  assert.match(calls.at(-1), /before=c26&limit=20$/);
  assert.deepEqual([chat.tasks.length, chat.tasks[0].seq, chat.currentTask.seq], [40, 6, 45]);
  await chat.loadOlder();
  assert.deepEqual(chat.tasks.map((x) => x.seq), Array.from({ length: 45 }, (_, i) => i + 1));
  assert.equal(new Set(chat.session.messages.map((m) => m.id)).size, 45);
  assert.equal(chat.hasOlder, false);
  const n = calls.length;
  await chat.loadOlder();
  assert.equal(calls.length, n, "nothing older to load");
});

test("a relaunch shows the saved copy first, then fetches only what changed", async (t) => {
  const mobd = office(30);
  const first = harness(t, mobd);
  await first.chat.setMachine("office", "http://office", "s", "server-1");
  await first.chat.loadOlder();
  await settle();

  mobd.change(2);
  mobd.add();
  let release;
  mobd.state.gate = new Promise((r) => { release = r; });
  const { chat, calls } = harness(t, mobd, first.store);
  const opening = chat.setMachine("office", "http://office", "s", "server-1");
  await settle();
  assert.equal(chat.loading, false, "the saved copy shows while mobd answers");
  assert.equal(chat.sync, "syncing");
  assert.deepEqual([chat.tasks[0].seq, chat.currentTask.seq], [11, 30]);
  release();
  await opening;
  mobd.state.gate = null;
  assert.match(calls.at(-1), /history\?since=30&limit=50$/);
  assert.equal(chat.sync, "");
  assert.equal(chat.currentTask.seq, 31, "the new turn is the current one");
  assert.ok(!chat.tasks.some((x) => x.seq === 2), "the changed old turn is not appended");
  // Older turns come from the local copy first, with the change saved.
  const n = calls.length;
  await chat.loadOlder();
  assert.equal(calls.length, n, "read from the local copy");
  assert.equal(chat.tasks[0].seq, 1);
  assert.equal(chat.session.messages.find((m) => m.taskId === "t2").content, "reply 2 r31");
});

test("a reset answer replaces the saved turns with the newest page", async (t) => {
  const mobd = office(25);
  const first = harness(t, mobd);
  await first.chat.setMachine("office", "http://office", "s", "server-1");
  await settle();
  mobd.state.reset = true;
  const { chat, calls } = harness(t, mobd, first.store);
  await chat.setMachine("office", "http://office", "s", "server-1");
  assert.match(calls.at(-2), /since=25/);
  assert.match(calls.at(-1), /history\?limit=20$/);
  assert.deepEqual([chat.tasks[0].seq, chat.currentTask.seq, chat.hasOlder], [6, 25, true]);
});

test("offline, saved conversations are readable and sending is off", async (t) => {
  const mobd = office(25);
  const first = harness(t, mobd);
  await first.chat.setMachine("office", "http://office", "s", "server-1");
  await settle();
  mobd.state.offline = true;
  const { chat } = harness(t, mobd, first.store);
  await chat.setMachine("office", "http://office", "s", "server-1");
  assert.deepEqual(chat.sessions.map((s) => s.id), ["s"]);
  assert.equal(chat.sync, "offline");
  assert.equal(chat.error, "");
  assert.deepEqual([chat.tasks[0].seq, chat.currentTask.seq], [6, 25]);
  assert.equal(chat.canSend, false);
  await chat.loadOlder();
  assert.equal(chat.olderError, "Older messages aren't available offline");
  mobd.state.offline = false;
  chat.retrySync();
  await settle();
  assert.equal(chat.sync, "");
  assert.equal(chat.canSend, true);
  await chat.loadOlder();
  assert.equal(chat.tasks[0].seq, 1);
});

test("a conversation deleted on mobd leaves the local copy", async (t) => {
  const mobd = office(3);
  const { chat, store } = harness(t, mobd);
  await chat.setMachine("office", "http://office", "s", "server-1");
  await settle();
  assert.ok(await store.load("server-1", "s", null, 1));
  mobd.state.gone = true;
  chat.resync();
  await settle();
  assert.equal(chat.sessionId, null);
  assert.equal(await store.load("server-1", "s", null, 1), null);
});

test("a mobd without sessionHistory keeps the full-snapshot request and saves nothing", async (t) => {
  const store = new MemoryHistory();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    const body = url.endsWith("/health") ? { apiVersion: 3, features: [] }
      : url.endsWith("/sessions") ? { sessions: [{ id: "s", title: "s", status: "succeeded" }] } : conversation([task(1, 1)], 1);
    return new Response(JSON.stringify(body));
  });
  const chat = new Chat(() => {}, () => {}, () => ({ addEventListener() {}, onerror: null, close() {} }), store);
  t.after(() => chat.newChat());
  await chat.setMachine("office", "http://office", "s", "server-1");
  await settle();
  assert.match(calls.at(-1), /\/sessions\/s$/);
  assert.equal(chat.hasOlder, false);
  assert.deepEqual(await store.list("server-1"), []);
  assert.deepEqual(replies(chat), ["reply 1 r1"]);
});
