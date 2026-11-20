import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
// Node runs the erasable TypeScript module directly (type stripping).
import { Chat, mergeDetail } from "./chat.ts";
import { configureAuth } from "./auth.ts";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function detail(id, status = "running", eventId = 3) {
  return {
    session: { id, title: id, status, activeTaskId: status === "running" ? `${id}-turn` : undefined,
      messages: [{ id: `${id}-turn:user`, taskId: `${id}-turn`, role: "user", content: `prompt ${id}` }] },
    tasks: [{ id: `${id}-turn`, sessionId: id, prompt: `prompt ${id}`, status, eventId, runner: "codex" }],
  };
}

function reply(data, text = "回复", itemId = "reply") {
  data.session.messages.push({ id: `${data.tasks.at(-1).id}:${itemId}`, taskId: data.tasks.at(-1).id, role: "assistant", content: text });
  return data;
}

function harness(t, handler) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    const result = await handler(url, init);
    return new Response(JSON.stringify(result.body ?? result), { status: result.statusCode ?? 200 });
  });
  const sources = [];
  class Source {
    listeners = new Map();
    closed = false;
    onerror = null;
    constructor(url, options) { this.url = url; this.options = options; sources.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    close() { this.closed = true; }
    emit(type, data) { this.listeners.get(type)?.({ type, data: JSON.stringify({ type, timestamp: "now", ...data }) }); }
  }
  const chat = new Chat(() => {}, () => {}, (url, options) => new Source(url, options));
  t.after(() => chat.newChat());
  return { chat, sources, calls };
}

async function settle() {
  await setImmediate();
  await setImmediate();
}

test("restores history, deduplicates replies, and continues the same session", async (t) => {
  let server = reply(detail("one", "succeeded"));
  const { chat, calls, sources } = harness(t, (url, init) => {
    if (url.endsWith("/sessions")) return { sessions: [server.session] };
    if (init?.method === "POST") {
      const task = { id: "next-turn", sessionId: "one", prompt: "follow up", status: "queued", eventId: 1, runner: "codex" };
      server.tasks.push(task);
      server.session.status = "queued";
      server.session.messages.push({ id: `${task.id}:user`, taskId: task.id, role: "user", content: task.prompt });
      return task;
    }
    return server;
  });
  await chat.setMachine("office", "http://office", "one");
  assert.equal(chat.session.messages[1].content, "回复");
  assert.equal(chat.canSend, true);
  assert.equal(await chat.submit("follow up"), true);
  const posted = calls.find((c) => c.init?.method === "POST");
  assert.deepEqual(JSON.parse(posted.init.body), { prompt: "follow up", sessionId: "one" });
  assert.match(sources.at(-1).url, /after=1$/);
  await settle();
  const source = sources.at(-1);
  source.emit("log", { id: 2, message: "[stdout] debug output" });
  source.emit("message", { id: 3, messageId: "item", message: "second reply" });
  source.emit("message", { id: 3, messageId: "item", message: "second reply" });
  assert.equal(chat.session.messages.filter((m) => m.content === "second reply").length, 1);
  assert.equal(chat.session.messages.some((m) => m.content.includes("debug output")), false);
  assert.equal(chat.canSend, false);
  server = structuredClone(server);
  server.tasks.at(-1).status = "succeeded";
  server.tasks.at(-1).eventId = 4;
  reply(server, "second reply", "item");
  source.emit("status", { id: 4, status: "succeeded" });
  assert.equal(chat.canSend, true);
  assert.equal(chat.sessions[0].status, "succeeded");
  await settle();
  assert.equal(chat.sessions.length, 1);
  assert.equal(chat.tasks.length, 2);
  assert.equal(chat.session.messages.length, 4);
});

test("blocks double Enter and stays busy after the POST finishes", async (t) => {
  const post = deferred();
  const server = detail("new", "queued", 1);
  const { chat, calls } = harness(t, (url, init) => {
    if (url.endsWith("/sessions")) return { sessions: [] };
    if (init?.method === "POST") return post.promise;
    return server;
  });
  await chat.setMachine("office", "http://office", null);
  const first = chat.submit("hello");
  assert.equal(await chat.submit("hello again"), false);
  assert.equal(calls.filter((c) => c.init?.method === "POST").length, 1);
  post.resolve(server.tasks[0]);
  assert.equal(await first, true);
  assert.equal(chat.sessions[0].id, "new");
  assert.equal(chat.busy, true);
  assert.equal(chat.canSend, false);
});

test("a late session fetch cannot replace a newer selection", async (t) => {
  const old = deferred();
  const { chat } = harness(t, (url) => {
    if (url.endsWith("/sessions")) return { sessions: [detail("a").session, detail("b").session] };
    if (url.endsWith("/a")) return old.promise;
    return reply(detail("b", "succeeded"), "reply B");
  });
  await chat.setMachine("office", "http://office", null);
  const a = chat.open("a");
  await chat.open("b");
  old.resolve(detail("a"));
  await a;
  assert.equal(chat.sessionId, "b");
  assert.equal(chat.session.messages.at(-1).content, "reply B");
});

test("switching machines ignores queued events from the previous machine", async (t) => {
  const { chat, sources } = harness(t, (url) => {
    const id = url.includes("office-a") ? "a" : "b";
    return url.endsWith("/sessions") ? { sessions: [detail(id).session] } : detail(id);
  });
  await chat.setMachine("a", "http://office-a");
  const old = sources[0];
  await chat.setMachine("b", "http://office-b");
  old.emit("message", { id: 100, messageId: "wrong", message: "wrong machine" });
  assert.equal(old.closed, true);
  assert.equal(chat.machineId, "b");
  assert.equal(chat.session.messages.some((m) => m.content === "wrong machine"), false);
});

test("disconnect recovery restores a missed reply and terminal status", async (t) => {
  let server = detail("one");
  const { chat, sources } = harness(t, (url) => url.endsWith("/sessions") ? { sessions: [server.session] } : server);
  await chat.setMachine("office", "http://office");
  const es = sources[0];
  server = reply(detail("one", "succeeded", 8), "missed final reply");
  es.onerror();
  assert.equal(es.closed, false, "leave native reconnect enabled until snapshot recovery succeeds");
  await settle();
  assert.equal(chat.session.messages.at(-1).content, "missed final reply");
  assert.equal(chat.canSend, true);
  assert.equal(es.closed, true);
});

test("restart recovery accepts the durable terminal snapshot after volatile log IDs disappear", async (t) => {
  let server = detail("one");
  const { chat, sources } = harness(t, (url) => url.endsWith("/sessions") ? { sessions: [server.session] } : server);
  await chat.setMachine("office", "http://office");
  sources[0].emit("log", { id: 100, message: "volatile log" });
  server = detail("one", "failed", 5);
  server.tasks[0].error = "interrupted by mobd restart";
  sources[0].onerror();
  await settle();
  assert.equal(chat.currentTask.status, "failed");
  assert.equal(chat.currentTask.error, "interrupted by mobd restart");
  assert.equal(chat.canSend, true);
});

test("a snapshot cannot erase a newer reply, and events update replacement task snapshots", async (t) => {
  let pending = null;
  let server = detail("one");
  const { chat, sources } = harness(t, (url) => {
    if (url.endsWith("/sessions")) return { sessions: [server.session] };
    return pending ? pending.promise : server;
  });
  await chat.setMachine("office", "http://office");
  const es = sources[0];
  pending = deferred();
  es.onerror();
  es.emit("message", { id: 4, messageId: "reply", message: "newer reply" });
  pending.resolve(detail("one", "running", 3));
  await settle();
  assert.equal(chat.session.messages.at(-1).content, "newer reply");
  pending = null;
  server = reply(detail("one", "running", 5), "newer reply");
  es.onerror();
  await settle();
  assert.equal(chat.currentTask.eventId, 5);
  server = reply(detail("one", "succeeded", 6), "newer reply");
  es.emit("status", { id: 6, status: "succeeded" });
  assert.equal(chat.currentTask.status, "succeeded");
  assert.equal(chat.canSend, true);
});

test("cancel waits for the terminal event before allowing another turn", async (t) => {
  let server = detail("one");
  const { chat, sources } = harness(t, (url, init) => {
    if (init?.method === "POST") return server.tasks[0];
    return url.endsWith("/sessions") ? { sessions: [server.session] } : server;
  });
  await chat.setMachine("office", "http://office");
  await chat.cancel();
  assert.equal(chat.cancelling, true);
  assert.equal(chat.canSend, false);
  server = detail("one", "cancelled", 4);
  sources[0].emit("status", { id: 4, status: "cancelled" });
  assert.equal(chat.cancelling, false);
  assert.equal(chat.canSend, true);
});

test("a POST completed after a machine switch cannot change the new conversation", async (t) => {
  const post = deferred();
  const { chat } = harness(t, (url, init) => {
    if (init?.method === "POST") return post.promise;
    return url.endsWith("/sessions") ? { sessions: [] } : detail("old");
  });
  await chat.setMachine("a", "http://a", null);
  const sending = chat.submit("old prompt");
  await chat.setMachine("b", "http://b", null);
  post.resolve(detail("old", "queued", 1).tasks[0]);
  assert.equal(await sending, false);
  assert.equal(chat.machineId, "b");
  assert.equal(chat.sessionId, null);
  assert.equal(chat.tasks.length, 0);
  assert.equal(chat.canSend, true);
});

test("an old backend blocks sends with an upgrade message", async (t) => {
  const { chat, calls } = harness(t, () => ({ statusCode: 404, body: { error: "not found" } }));
  await chat.setMachine("office", "http://office");
  assert.match(chat.error, /Update mobd on this computer/);
  assert.equal(await chat.submit("hello"), false);
  assert.equal(calls.some((c) => c.init?.method === "POST"), false);
});

test("a named runner error is not treated as a transport reconnect", async (t) => {
  const server = detail("one");
  const { chat, sources, calls } = harness(t, (url) => url.endsWith("/sessions") ? { sessions: [server.session] } : server);
  await chat.setMachine("office", "http://office");
  const before = calls.length;
  sources[0].emit("error", { id: 4, message: "save conversation: disk full" });
  sources[0].onerror({ data: "named event" });
  await settle();
  assert.match(chat.error, /disk full/);
  assert.equal(calls.length, before);
});

test("requests carry the credential; a 401 stops and asks for pairing", async (t) => {
  const rejected = [];
  configureAuth({ token: (base) => (base === "http://office" ? "secret" : undefined), unauthorized: (base) => rejected.push(base) });
  t.after(() => configureAuth({ token: () => undefined, unauthorized: () => {} }));
  const server = detail("one");
  let status = 200;
  const { chat, calls, sources } = harness(t, (url) => {
    if (status === 401) return { statusCode: 401, body: { error: "unauthorized" } };
    return url.endsWith("/sessions") ? { sessions: [server.session] } : server;
  });
  await chat.setMachine("office", "http://office/");
  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.equal(c.init.headers.get("Authorization"), "Bearer secret");
    assert.equal(c.init.redirect, "error");
  }
  assert.equal(sources[0].options.headers().get("Authorization"), "Bearer secret");
  assert.equal(sources[0].options.resumeParam, "after");
  status = 401;
  const before = calls.length;
  await chat.refresh();
  assert.match(chat.error, /paired again/);
  assert.deepEqual(rejected, ["http://office"]);
  assert.equal(calls.length, before + 1, "no retry after 401");
  sources[0].options.onUnauthorized();
  assert.equal(sources[0].closed, true);
});

function turns(list, rev, full) {
  return {
    session: { id: "s", title: "s", status: "succeeded",
      messages: list.map(([id, , text]) => ({ id: `${id}:a`, taskId: id, role: "assistant", content: text })) },
    tasks: list.map(([id, status]) => ({ id, sessionId: "s", status, eventId: 1, runner: "codex" })),
    activities: list.map(([id, , text]) => ({ id: `${id}:1`, taskId: id, kind: "tool", status: "completed", title: text })),
    questions: [], rev, full,
  };
}

test("a partial answer replaces only the turns it carries, in turn order", () => {
  const base = turns([["t1", "succeeded", "one"], ["t2", "running", "two…"]], 5, true);
  const d = mergeDetail(base, turns([["t2", "succeeded", "two"], ["t3", "running", "three"]], 9, false));
  assert.equal(d.rev, 9);
  assert.deepEqual(d.tasks.map((t) => [t.id, t.status]), [["t1", "succeeded"], ["t2", "succeeded"], ["t3", "running"]]);
  assert.deepEqual(d.session.messages.map((m) => m.content), ["one", "two", "three"]);
  assert.deepEqual(d.activities.map((a) => a.title), ["one", "two", "three"]);
  const older = mergeDetail(d, turns([["t1", "succeeded", "one, edited"]], 10, false));
  assert.deepEqual(older.session.messages.map((m) => m.content), ["one, edited", "two", "three"]);
  // A full answer, or one from a mobd without revisions, replaces everything.
  assert.deepEqual(mergeDetail(d, turns([["t2", "succeeded", "two"]], 3, true)).tasks.map((t) => t.id), ["t2"]);
  assert.deepEqual(mergeDetail(d, turns([["t1", "succeeded", "one"]])).tasks.map((t) => t.id), ["t1"]);
});

test("reopening a conversation shows it at once and fetches only what changed", async (t) => {
  const answers = { a: turns([["t1", "succeeded", "one"]], 4, true), b: { ...detail("b", "succeeded"), rev: 7, full: true } };
  const gate = deferred();
  let hold = false;
  const { chat, calls } = harness(t, async (url) => {
    if (url.endsWith("/sessions")) return { sessions: [{ id: "s" }, { id: "b" }] };
    if (url.includes("/sessions/s?since=4")) {
      if (hold) await gate.promise;
      return turns([["t2", "succeeded", "two"]], 6, false);
    }
    return url.includes("/sessions/s") ? answers.a : answers.b;
  });
  await chat.setMachine("office", "http://office", "s");
  await chat.open("b");
  hold = true;
  const opening = chat.open("s");
  assert.equal(chat.loading, false, "the cached copy shows while mobd answers");
  assert.deepEqual(chat.session.messages.map((m) => m.content), ["one"]);
  gate.resolve();
  await opening;
  assert.match(calls.at(-1).url, /\/sessions\/s\?since=4$/);
  assert.deepEqual(chat.session.messages.map((m) => m.content), ["one", "two"]);
  await chat.open("b");
  assert.match(calls.at(-1).url, /\/sessions\/b\?since=7$/);
  await chat.setMachine("office", "http://office", "s");
  assert.match(calls.at(-1).url, /\/sessions\/s$/, "another machine starts without a cache");
});
