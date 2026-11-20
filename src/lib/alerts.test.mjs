import test from "node:test";
import assert from "node:assert/strict";
import { alertsFor } from "./alerts.ts";

const prefs = { needs: true, done: true, failed: true, computers: {} };
const s = (id, more = {}) => ({ id, title: id, status: "succeeded", ...more });

test("alerts follow changes, not what a computer had when it loaded", () => {
  const seen = new Map();
  assert.deepEqual(alertsFor(seen, [{ machineId: "m", sessions: [s("a", { waiting: true, activeTaskId: "t", status: "running" })] }], prefs), []);
  const working = [{ machineId: "m", sessions: [s("a", { activeTaskId: "t", status: "running" }), s("b", { activeTaskId: "u", status: "running" })] }];
  assert.deepEqual(alertsFor(seen, working, prefs), []);
  const after = [{ machineId: "m", sessions: [s("a", { waiting: true, activeTaskId: "t", status: "running" }), s("b", { status: "failed" })] }];
  assert.deepEqual(alertsFor(seen, after, prefs).map((a) => `${a.kind}:${a.session.id}`), ["needs:a", "failed:b"]);
  const done = [{ machineId: "m", sessions: [s("a"), s("b", { status: "failed" })] }];
  assert.deepEqual(alertsFor(seen, done, prefs).map((a) => a.kind), ["done"]);
});

test("a computer set to 'only when it needs me' and turned-off kinds stay quiet", () => {
  const seen = new Map([["m/a", { waiting: false, active: true }], ["m/b", { waiting: false, active: true }]]);
  const lists = [{ machineId: "m", sessions: [s("a"), s("b", { waiting: true, activeTaskId: "t", status: "running" })] }];
  assert.deepEqual(alertsFor(new Map(seen), lists, { ...prefs, computers: { m: "needs" } }).map((a) => a.kind), ["needs"]);
  assert.deepEqual(alertsFor(new Map(seen), lists, { ...prefs, needs: false }).map((a) => a.kind), ["done"]);
});
