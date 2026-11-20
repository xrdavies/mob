import test from "node:test";
import assert from "node:assert/strict";
import { closeDesktop, fetchDesktops, screenUrl, seedDesktop, sessionDesktops } from "../api/client.ts";
import { configureAuth } from "./auth.ts";
import { Chat } from "./chat.ts";
import {
  applyDesktop, applyLevel, bannerState, desktopMark, formatBytes, NO_DESKTOP, parseDesktop, parseDesktops, parseDisk,
  parseMemory, queueReasonText, seedErrorText,
} from "./desktops.ts";
import { openSession } from "./stream.ts";

function mockFetch(t, status, body) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  });
  return calls;
}

const desktop = (sessionId, state, memoryBytes = 0, extra = {}) =>
  ({ sessionId, state, memoryBytes, diskBytes: 0, width: 1280, height: 800, scale: 1, viewers: 0, ...extra });

test("sessionDesktops is gated on API v3 and the feature", () => {
  assert.equal(sessionDesktops(undefined), false);
  assert.equal(sessionDesktops({ apiVersion: 3, features: ["stream", "screen"] }), false);
  assert.equal(sessionDesktops({ apiVersion: 2, features: ["sessionDesktops"] }), false);
  assert.equal(sessionDesktops({ apiVersion: 3, features: ["stream", "sessionDesktops"] }), true);
});

test("screenUrl names the conversation only when given one", () => {
  assert.equal(screenUrl("http://office", 704), "http://office/screen?maxWidth=704&quality=65");
  assert.equal(screenUrl("http://office", 704, 65, "s 1"), "http://office/screen?maxWidth=704&quality=65&sessionId=s%201");
});

test("openSession sends sessionId only when set", async (t) => {
  const calls = mockFetch(t, 201, { session: "S", answer: "v=0", width: 1, height: 1 });
  await openSession("http://office", { offer: "o", maxWidth: 2, maxHeight: 2, quality: "auto" });
  await openSession("http://office", { offer: "o", maxWidth: 2, maxHeight: 2, quality: "auto", sessionId: "c1" });
  assert.equal("sessionId" in JSON.parse(calls[0].init.body), false);
  assert.equal(JSON.parse(calls[1].init.body).sessionId, "c1");
});

test("openSession maps conversation desktop errors by code", async (t) => {
  mockFetch(t, 409, { error: "the conversation has no desktop yet", code: "no_desktop" });
  await assert.rejects(openSession("http://office", { maxWidth: 1, maxHeight: 1, quality: "auto", sessionId: "c" }),
    { message: NO_DESKTOP, code: "no_desktop", status: 409 });
  t.mock.restoreAll();
  mockFetch(t, 404, { error: "conversation not found", code: "session_not_found" });
  await assert.rejects(openSession("http://office", { maxWidth: 1, maxHeight: 1, quality: "auto", sessionId: "c" }),
    { message: "conversation not found", code: "session_not_found" });
  t.mock.restoreAll();
  mockFetch(t, 503, { error: "Xvfb did not start", code: "desktop_unavailable" });
  await assert.rejects(openSession("http://office", { maxWidth: 1, maxHeight: 1, quality: "auto", sessionId: "c" }),
    { message: "Xvfb did not start", code: "desktop_unavailable" });
});

test("desktop requests use the conversation's path and carry mobd's codes", async (t) => {
  configureAuth({ token: () => "T" });
  t.after(() => configureAuth({ token: () => undefined }));
  let calls = mockFetch(t, 204);
  await closeDesktop("http://office", "c/1");
  assert.equal(calls[0].url, "http://office/desktops/c%2F1");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer T");
  await seedDesktop("http://office", "c1");
  assert.equal(calls[1].url, "http://office/desktops/c1/seed");
  assert.equal(calls[1].init.method, "POST");
  t.mock.restoreAll();
  mockFetch(t, 409, { error: "a browser is running", code: "browser_running" });
  const err = await seedDesktop("http://office", "c1").catch((e) => e);
  assert.equal(err.code, "browser_running");
  assert.equal(seedErrorText(err), "Close the browser in this conversation first");
  assert.equal(seedErrorText({ code: "no_profile", message: "no browser profile yet" }), "no browser profile yet");
  t.mock.restoreAll();
  calls = mockFetch(t, 200, { desktops: [desktop("a", "running", 1), desktop("b", "asleep", 9)], memory: { level: "low", availableBytes: 1, totalBytes: 8, pressure: 0.2 } });
  const list = await fetchDesktops("http://office");
  assert.equal(calls[0].url, "http://office/desktops");
  assert.deepEqual(list.desktops.map((d) => d.sessionId), ["b", "a"]);
  assert.equal(list.memory.level, "low");
});

test("parseDesktop validates DesktopInfo", () => {
  assert.equal(parseDesktop(null), null);
  assert.equal(parseDesktop({ state: "running" }), null);
  assert.equal(parseDesktop({ sessionId: "a", state: "melted" }), null);
  const d = parseDesktop({ sessionId: "a", state: "closed", reason: "oomKill", memoryBytes: "x", title: "T", viewers: 2 });
  assert.equal(d.reason, "oomKill");
  assert.equal(d.memoryBytes, 0);
  assert.equal(d.scale, 1);
  assert.equal(d.viewers, 2);
  assert.equal(d.title, "T");
});

test("parseDesktops sorts by memory and tolerates a shared desktop", () => {
  assert.deepEqual(parseDesktops({ desktops: [] }), { desktops: [], memory: undefined, disk: undefined });
  assert.deepEqual(parseDesktops(null).desktops, []);
  const r = parseDesktops({ desktops: [desktop("a", "running", 5), { bad: 1 }, desktop("b", "running", 50)], disk: { level: "critical", freeBytes: 1, totalBytes: 2 } });
  assert.deepEqual(r.desktops.map((d) => d.sessionId), ["b", "a"]);
  assert.equal(r.disk.level, "critical");
  assert.equal(parseMemory({ level: "weird" }), undefined);
  assert.equal(parseDisk({ level: "ok", freeBytes: 3 }).freeBytes, 3);
});

test("desktop events update the list; closed removes it", () => {
  let s = applyDesktop(undefined, parseDesktop(desktop("a", "starting", 1)));
  s = applyDesktop(s, parseDesktop(desktop("b", "running", 10)));
  assert.deepEqual(s.desktops.map((d) => d.sessionId), ["b", "a"]);
  s = applyDesktop(s, parseDesktop(desktop("a", "asleep", 100)));
  assert.deepEqual(s.desktops.map((d) => [d.sessionId, d.state]), [["a", "asleep"], ["b", "running"]]);
  s = applyDesktop(s, parseDesktop(desktop("b", "closed", 0, { reason: "user" })));
  assert.deepEqual(s.desktops.map((d) => d.sessionId), ["a"]);
  s = applyLevel(s, "memory", parseMemory({ level: "critical", availableBytes: 1, totalBytes: 2, pressure: 1 }));
  assert.equal(s.memory.level, "critical");
  assert.equal(s.desktops.length, 1);
});

test("desktopMark tells running from asleep", () => {
  assert.equal(desktopMark(undefined), null);
  assert.equal(desktopMark(desktop("a", "running")), "running");
  assert.equal(desktopMark(desktop("a", "waking")), "running");
  assert.equal(desktopMark(desktop("a", "asleep")), "asleep");
  assert.equal(desktopMark(desktop("a", "failed")), null);
});

test("queue reasons read as the spec says", () => {
  assert.equal(queueReasonText("slots"), "Waiting for a free slot");
  assert.equal(queueReasonText("desktops"), "Waiting: the desktop limit is reached");
  assert.equal(queueReasonText("memory"), "Waiting: the computer is low on memory");
  assert.equal(queueReasonText("disk"), "Waiting: the computer is low on disk space");
  assert.equal(queueReasonText("desktopStarting"), "Starting the desktop");
  assert.equal(queueReasonText(undefined), "");
  assert.equal(queueReasonText("toString"), "");
});

test("bannerState follows the memory and disk levels", () => {
  assert.equal(bannerState(undefined), null);
  assert.equal(bannerState({ desktops: [], memory: { level: "ok" }, disk: { level: "ok" } }), null);
  const low = bannerState({ desktops: [], memory: { level: "low" } });
  assert.equal(low.message, "The computer is low on memory. Close desktops or delete conversations you no longer need.");
  assert.equal(low.critical, false);
  const disk = bannerState({ desktops: [], disk: { level: "critical" } });
  assert.equal(disk.message, "The computer is low on disk space. Close desktops or delete conversations you no longer need. New conversations wait until disk space is freed.");
  assert.equal(disk.critical, true);
  const both = bannerState({ desktops: [], memory: { level: "critical" }, disk: { level: "low" } });
  assert.match(both.message, /low on memory and disk space\./);
  assert.match(both.message, /wait until memory is freed\.$/);
  assert.notEqual(low.key, bannerState({ desktops: [], memory: { level: "critical" } }).key);
});

test("formatBytes", () => {
  assert.equal(formatBytes(1_400_000_000), "1.4 GB");
  assert.equal(formatBytes(350_000_000), "350 MB");
  assert.equal(formatBytes(2_000), "2 KB");
});

test("Chat keeps the queued turn's reason current from queue and task events", () => {
  let changes = 0;
  const c = new Chat(() => changes++, () => {});
  c.tasks = [{ id: "t", sessionId: "s", status: "queued", queuePosition: 2, eventId: 0, prompt: "", runner: "codex" }];
  c.applyQueue({ running: [], queued: [{ id: "t", sessionId: "s", status: "queued", queuePosition: 1, queueReason: "memory" }] });
  assert.equal(c.currentTask.queuePosition, 1);
  assert.equal(c.currentTask.queueReason, "memory");
  const before = changes;
  c.applyTask({ id: "other", status: "queued", queueReason: "slots" });
  assert.equal(changes, before);
  c.applyTask({ id: "t", status: "queued", queuePosition: 1, queueReason: "desktopStarting" });
  assert.equal(c.currentTask.queueReason, "desktopStarting");
  c.applyTask({ id: "t", status: "queued", queuePosition: 1, queueReason: "desktopStarting" });
  assert.equal(changes, before + 1);
});
