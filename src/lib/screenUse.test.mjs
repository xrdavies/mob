import test from "node:test";
import assert from "node:assert/strict";
import { applyScreenUse, parseScreenUse, screenUseText } from "./screenUse.ts";

test("screen use events start, extend and end", () => {
  const agent = parseScreenUse({ source: "agent", sessionId: "s1", taskId: "t1", active: true, since: "2026-11-12T10:00:00Z" });
  const phone = parseScreenUse({ source: "control", clientId: "c1", sessionId: "s1", active: true, since: "x" });
  let list = applyScreenUse(applyScreenUse([], agent), phone);
  assert.equal(list.length, 2);
  list = applyScreenUse(list, { ...agent, taskId: "t2" });
  assert.equal(list.length, 2, "a later turn of the same conversation replaces it");
  list = applyScreenUse(list, { ...phone, active: false });
  assert.deepEqual(list.map((u) => u.source), ["agent"]);
  assert.deepEqual(applyScreenUse(list, { ...agent, active: false }), []);
});

test("screen use parsing rejects other shapes", () => {
  for (const bad of [null, "x", {}, { source: "phone", active: true }, { source: "agent" }, { source: "agent", active: "yes" }]) {
    assert.equal(parseScreenUse(bad), null);
  }
  assert.equal(parseScreenUse({ source: "agent", active: true, sessionId: "" }).sessionId, undefined);
});

test("indicator text names the agent's conversation first", () => {
  const titles = { s1: "Fix the build" };
  const t = (id) => titles[id];
  assert.equal(screenUseText([], t), "");
  const agent = { source: "agent", sessionId: "s1", active: true, since: "" };
  const phone = { source: "control", clientId: "c1", active: true, since: "" };
  assert.equal(screenUseText([agent], t), "Agent is using the screen · Fix the build");
  assert.equal(screenUseText([phone, agent], t), "Agent is using the screen · Fix the build (+1)");
  assert.equal(screenUseText([phone], t), "Another device is controlling this computer");
  assert.equal(screenUseText([phone, { ...phone, clientId: "c2" }], t), "2 devices are controlling this computer");
});
