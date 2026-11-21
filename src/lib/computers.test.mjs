import test from "node:test";
import assert from "node:assert/strict";
import { applySessionEvent, needsYou, removeSession, sessionLine, visibleSessions } from "./computers.ts";

const s = (id, updatedAt, more = {}) => ({ id, title: id, status: "succeeded", updatedAt, ...more });

test("session events keep a computer's list current", () => {
  let list = applySessionEvent([], s("a", "2026-11-01"));
  list = applySessionEvent(list, s("b", "2026-11-02"));
  assert.deepEqual(list.map((x) => x.id), ["b", "a"]);
  list = applySessionEvent(list, s("a", "2026-11-03", { title: "renamed" }));
  assert.deepEqual(list.map((x) => x.title), ["renamed", "b"]);
  assert.deepEqual(applySessionEvent(list, s("a", "2026-11-04", { archived: true })).map((x) => x.id), ["b"]);
  assert.deepEqual(removeSession(list, "b").map((x) => x.id), ["a"]);
});

test("the sidebar shows a few recent conversations, never hiding one that needs the user", () => {
  const list = [s("1", "5"), s("2", "4"), s("3", "3"), s("4", "2", { waiting: true }), s("5", "1", { pinned: true })];
  const v = visibleSessions(list, 3, false, null);
  assert.deepEqual(v.shown.map((x) => x.id), ["1", "4", "5"]);
  assert.equal(v.hidden, 2);
  assert.equal(visibleSessions(list, 3, true).hidden, 0);
  assert.deepEqual(visibleSessions(list, 3, false, "3").shown.map((x) => x.id), ["3", "4", "5"]);
  assert.equal(visibleSessions(list.slice(0, 2), 3, false).hidden, 0);
});

test("needs you collects waiting conversations across computers, longest waiting first", () => {
  const w = needsYou([
    { machineId: "a", sessions: [s("x", "2026-11-03", { waiting: true }), s("y", "2026-11-01")] },
    { machineId: "b", sessions: [s("z", "2026-11-02", { waiting: true }), s("q", "2026-11-01", { waiting: true, archived: true })] },
  ]);
  assert.deepEqual(w.map((x) => `${x.machineId}/${x.session.id}`), ["b/z", "a/x"]);
});

test("status lines", () => {
  assert.equal(sessionLine(s("a", "", { waiting: true, activeTaskId: "t", status: "running" })).tone, "needs");
  assert.equal(sessionLine(s("a", "", { activeTaskId: "t", status: "running" })).text, "Working");
  assert.equal(sessionLine(s("a", "", { status: "cancelled" })).text, "Stopped");
  assert.equal(sessionLine(s("a", "", { status: "succeeded" })).text, "Done");
  assert.equal(sessionLine(s("a", "", { activeTaskId: "t", status: "queued" }), 2).text, "Queued #2");
  assert.equal(sessionLine(s("a", "", { status: "failed" })).tone, "failed");
  assert.equal(sessionLine(s("a", "")).tone, "done");
});
