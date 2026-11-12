import test from "node:test";
import assert from "node:assert/strict";
import { deviceNameError, pair, parsePairLink } from "./pairing.ts";
import { authFetch, configureAuth, responseError, UnauthorizedError } from "./auth.ts";

test("parses links in any parameter order, with ports and IPv6", () => {
  assert.deepEqual(parsePairLink("  https://office.example.com/pair#invite=I&serverId=S&v=1\n"),
    { origin: "https://office.example.com", invite: "I", serverId: "S", insecure: false });
  assert.deepEqual(parsePairLink("http://192.168.1.20:8080/pair#v=1&serverId=S&invite=I"),
    { origin: "http://192.168.1.20:8080", invite: "I", serverId: "S", insecure: true });
  assert.equal(parsePairLink("http://[fd7a:115c::1]:8080/pair#v=1&serverId=S&invite=I").origin, "http://[fd7a:115c::1]:8080");
});

test("rejects malformed links with readable errors", () => {
  const bad = {
    "": /Paste/,
    "not a link": /not a valid link/,
    "ftp://h/pair#v=1&serverId=S&invite=I": /http/,
    "https://u:p@h/pair#v=1&serverId=S&invite=I": /user name/,
    "https://h/pairing#v=1&serverId=S&invite=I": /\/pair/,
    "https://h/pair/#v=1&serverId=S&invite=I": /\/pair/,
    "https://h/pair?x=1#v=1&serverId=S&invite=I": /query/,
    "https://h/pair?#v=1&serverId=S&invite=I": /query/,
    "https://h/pair#v=2&serverId=S&invite=I": /newer/,
    "https://h/pair#serverId=S&invite=I": /incomplete/,
    "https://h/pair#v=1&serverId=S": /incomplete/,
    "https://h/pair#v=1&invite=I": /incomplete/,
    "https://h/pair#v=1&serverId=S&invite=I&invite=J": /malformed/,
  };
  for (const [link, message] of Object.entries(bad)) assert.throws(() => parsePairLink(link), message, link);
});

test("device names follow mobd's rules", () => {
  assert.equal(deviceNameError("mob on Mac"), "");
  assert.match(deviceNameError("  "), /Enter/);
  assert.match(deviceNameError("x".repeat(129)), /too long/);
  assert.match(deviceNameError("é".repeat(65)), /too long/);
  assert.match(deviceNameError("a\tb"), /invalid/);
});

const link = parsePairLink("http://office:8080/pair#v=1&serverId=S&invite=I");

function mockFetch(t, status, body) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

test("pair posts the invite to the link origin without a credential", async (t) => {
  configureAuth({ token: () => "old-secret" });
  t.after(() => configureAuth({ token: () => undefined }));
  const calls = mockFetch(t, 201, { serverId: "S", clientId: "C", token: "T" });
  assert.deepEqual(await pair(link, "  My Mac "), { serverId: "S", clientId: "C", token: "T" });
  assert.equal(calls[0].url, "http://office:8080/pair");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].init.body), { invite: "I", name: "My Mac" });
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), null);
});

test("pair maps statuses to readable errors", async (t) => {
  const cases = [[401, /expired or already used.*mobd link/], [400, /rejected.*bad name/], [503, /could not save/], [404, /Update mobd/], [500, /Pairing failed/]];
  for (const [status, message] of cases) {
    mockFetch(t, status, { error: "bad name" });
    await assert.rejects(pair(link, "Mac"), message, String(status));
    t.mock.restoreAll();
  }
  // No invitation open on the office computer: the link is spent, mobd is not outdated.
  mockFetch(t, 404, { error: "pairing is off", code: "pairing_closed" });
  await assert.rejects(pair(link, "Mac"), /expired or already used.*mobd link/);
});

test("pair rejects a different serverId and invalid responses", async (t) => {
  mockFetch(t, 201, { serverId: "OTHER", clientId: "C", token: "T" });
  await assert.rejects(pair(link, "Mac"), /different server ID/);
  t.mock.restoreAll();
  mockFetch(t, 201, { serverId: "S", clientId: "C" });
  await assert.rejects(pair(link, "Mac"), /Invalid pairing response/);
});

test("pair reports unreachable hosts", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Load failed"); });
  await assert.rejects(pair(link, "Mac"), /Could not reach http:\/\/office:8080/);
});

test("authFetch adds the bearer header and reports 401 once", async (t) => {
  const rejected = [];
  configureAuth({ token: (base) => (base === "http://office" ? "T" : undefined), unauthorized: (base) => rejected.push(base) });
  t.after(() => configureAuth({ token: () => undefined, unauthorized: () => {} }));
  const calls = mockFetch(t, 200, {});
  await authFetch("http://office/", "http://office/health", { headers: { "X-Test": "1" } });
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer T");
  assert.equal(calls[0].init.headers.get("X-Test"), "1");
  await authFetch("http://elsewhere", "http://elsewhere/health");
  assert.equal(calls[1].init.headers.get("Authorization"), null);
  t.mock.restoreAll();
  mockFetch(t, 401, { error: "unauthorized" });
  await assert.rejects(authFetch("http://office", "http://office/health"), UnauthorizedError);
  assert.deepEqual(rejected, ["http://office"]);
});

test("responseError prefers mobd's message over the status", async () => {
  assert.equal(await responseError(new Response(JSON.stringify({ error: "the office computer is locked" }), { status: 503 })), "the office computer is locked");
  assert.equal(await responseError(new Response("<html>", { status: 502 })), "HTTP 502");
  assert.equal(await responseError(new Response(JSON.stringify({ error: "" }), { status: 500 })), "HTTP 500");
});

test("unpair removes this device's pairing with its own credential", async () => {
  const { unpair } = await import("./pairing.ts");
  const real = globalThis.fetch;
  const calls = [];
  const answer = (status) => (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization });
    return Promise.resolve(new Response(null, { status }));
  };
  try {
    globalThis.fetch = answer(204);
    assert.equal(await unpair("http://127.0.0.1:8080/", "tok"), "removed");
    assert.deepEqual(calls[0], { url: "http://127.0.0.1:8080/pair", method: "DELETE", auth: "Bearer tok" });
    for (const [status, want] of [[401, "removed"], [404, "removed"], [405, "unsupported"], [500, "failed"]]) {
      globalThis.fetch = answer(status);
      assert.equal(await unpair("https://office.example", "tok"), want, String(status));
    }
    globalThis.fetch = () => Promise.reject(new TypeError("offline"));
    assert.equal(await unpair("https://office.example", "tok"), "failed");
  } finally {
    globalThis.fetch = real;
  }
});
