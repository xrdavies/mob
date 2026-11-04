import test from "node:test";
import assert from "node:assert/strict";
import { validHandle, suggestHandle, mentionAt, mentionCandidates, mentionToken, resolveMentions, parseDelivery, agentLabel, requestEnded, needsUser } from "./collab.ts";

test("validHandle accepts lowercase letters, digits, dash; starts with a letter; rejects all-hex and reserved", () => {
  assert.ok(validHandle("api"));
  assert.ok(validHandle("order-service"));
  assert.ok(validHandle("x2"));
  assert.ok(!validHandle("a2"), "all-hex");
  assert.ok(!validHandle("API"), "uppercase");
  assert.ok(!validHandle("1api"), "starts with digit");
  assert.ok(!validHandle("a"), "too short");
  assert.ok(!validHandle("a".repeat(33)), "too long");
  assert.ok(!validHandle("api_service"), "underscore");
  assert.ok(!validHandle("abc123"), "all-hex reads as ID");
  assert.ok(!validHandle("user"), "reserved");
  assert.ok(!validHandle("all"), "reserved");
});

test("suggestHandle derives from title, avoids taken names and all-hex, numbers collisions", () => {
  assert.equal(suggestHandle("Order API", []), "order-api");
  assert.equal(suggestHandle("Order   Service!", []), "order-service");
  assert.equal(suggestHandle("123 API Agent", []), "api-agent");
  assert.equal(suggestHandle("Order API", ["order-api"]), "order-api-2");
  assert.equal(suggestHandle("Order API", ["order-api", "order-api-2"]), "order-api-3");
  assert.equal(suggestHandle("API", []), "api");
  assert.equal(suggestHandle("abcdef", []), "abcdef-agent"); // all-hex
  assert.equal(suggestHandle("!!!!", []), "agent");
  assert.equal(suggestHandle("user", []), "user-agent"); // reserved word
  assert.equal(suggestHandle("A".repeat(100), []), "agent"); // all-hex fallback
});

test("mentionAt finds @ word at the cursor", () => {
  assert.deepEqual(mentionAt("@a", 2), { query: "a", start: 0 });
  assert.deepEqual(mentionAt("ask @ap", 7), { query: "ap", start: 4 });
  assert.deepEqual(mentionAt("ask @api here", 8), { query: "api", start: 4 });
  assert.deepEqual(mentionAt("@", 1), { query: "", start: 0 });
  assert.equal(mentionAt("@api ", 5), null, "space after");
  assert.equal(mentionAt("no mention", 5), null);
  assert.equal(mentionAt("email@example", 13), null, "not after space");
});

test("mentionCandidates ranks handle prefix, title word, short ID; excludes self; keeps archived", () => {
  const sessions = [
    { id: "a1b2c3d4e5f6", title: "Order API", handle: "api", runner: "codex", archived: false },
    { id: "b2c3d4e5f6a1", title: "Billing Service", handle: "billing", runner: "codex", archived: false },
    { id: "c3d4e5f6a1b2", title: "API Docs", handle: "", runner: "codex", archived: true },
    { id: "d4e5f6a1b2c3", title: "Shipping", handle: "ship", runner: "codex", archived: false },
  ];
  const all = mentionCandidates(sessions, "", null);
  assert.equal(all.length, 4);
  assert.equal(all[0].handle, "api", "handles first when query is empty");
  const ap = mentionCandidates(sessions, "ap", null);
  assert.equal(ap.length, 2);
  assert.equal(ap[0].handle, "api", "handle prefix");
  assert.equal(ap[1].title, "API Docs", "title word");
  const bill = mentionCandidates(sessions, "bill", null);
  assert.equal(bill[0].handle, "billing");
  const byId = mentionCandidates(sessions, "a1b2", null);
  assert.equal(byId[0].id, "a1b2c3d4e5f6", "short ID match");
  const noSelf = mentionCandidates(sessions, "", "a1b2c3d4e5f6");
  assert.ok(!noSelf.some((s) => s.id === "a1b2c3d4e5f6"), "excludes self");
});

test("agentLabel and mentionToken", () => {
  assert.equal(agentLabel({ id: "abc123", title: "API", handle: "api" }), "@api");
  assert.equal(agentLabel({ id: "abc123", title: "Billing", handle: "" }), "Billing (abc123)");
  assert.equal(mentionToken({ id: "abc123def", handle: "api" }), "@api");
  assert.equal(mentionToken({ id: "abc123def", handle: "" }), "@abc123");
});

test("resolveMentions finds @handle and @short-id, reports archived, ignores unknown words", () => {
  const sessions = [
    { id: "a1b2c3d4e5f6", title: "Order API", handle: "api", runner: "codex", archived: false },
    { id: "b2c3d4e5f6a1", title: "Billing", handle: "billing", runner: "codex", archived: false },
    { id: "c3d4e5f6a1b2", title: "Docs", handle: "docs", runner: "codex", archived: true },
  ];
  const { ids, archived } = resolveMentions("ask @api and @billing about @docs and @nobody", sessions, null);
  assert.deepEqual(ids, ["a1b2c3d4e5f6", "b2c3d4e5f6a1"]);
  assert.deepEqual(archived, ["@docs"]);
  const byId = resolveMentions("ask @a1b2c3", sessions, null);
  assert.deepEqual(byId.ids, ["a1b2c3d4e5f6"]);
  const ambig = resolveMentions("ask @a", sessions, null); // matches two
  assert.deepEqual(ambig.ids, []);
  const noSelf = resolveMentions("ask @api", sessions, "a1b2c3d4e5f6");
  assert.deepEqual(noSelf.ids, []);
});

test("parseDelivery splits Mob collaboration headers", () => {
  const prompt = `[Mob collaboration · from @api · request r-abc123 · exchange x-1]\nRequest: Which fields?\n\n---\n\n[Mob collaboration · from Mob · request r-def456 · exchange x-1]\nYour request: cancelled.`;
  const parts = parseDelivery(prompt);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].from, "@api");
  assert.equal(parts[0].request, "r-abc123");
  assert.ok(parts[0].body.startsWith("Request: Which fields"));
  assert.equal(parts[1].from, "Mob");
});

test("requestEnded and needsUser", () => {
  assert.ok(!requestEnded("open"));
  assert.ok(!requestEnded("in_progress"));
  assert.ok(requestEnded("answered"));
  assert.ok(requestEnded("interrupted"));
  assert.ok(needsUser("interrupted"));
  assert.ok(needsUser("over_budget"));
  assert.ok(!needsUser("answered"));
});
