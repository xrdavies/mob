import test from "node:test";
import assert from "node:assert/strict";
import { emptyFolders, encodeRemote, joinLocal, joinRemote, localCrumbs, parentLocal, parentRemote, sortEntries, transferRows } from "./filesPaths.ts";

test("remote paths stay inside the shared folder", () => {
  assert.equal(joinRemote("", "a.txt"), "a.txt");
  assert.equal(joinRemote("a/b", "c.txt"), "a/b/c.txt");
  assert.equal(parentRemote("a/b/c.txt"), "a/b");
  assert.equal(parentRemote("a"), "");
  assert.equal(encodeRemote("报告 1/a#b?.txt"), "%E6%8A%A5%E5%91%8A%201/a%23b%3F.txt");
});

test("local paths go up to the root and show Home", () => {
  assert.equal(joinLocal("/Users/me", "x"), "/Users/me/x");
  assert.equal(joinLocal("/", "x"), "/x");
  assert.equal(parentLocal("/Users/me/Downloads"), "/Users/me");
  assert.equal(parentLocal("/Users"), "/");
  assert.equal(parentLocal("/"), undefined);
  assert.equal(parentLocal("C:\\Users\\me"), "C:\\Users");
  assert.equal(parentLocal("C:\\Users"), "C:\\");
  assert.equal(parentLocal("C:\\"), undefined);
  assert.deepEqual(localCrumbs("/Users/me", "/Users/me/Downloads/work").map(c => c.label), ["Home", "Downloads", "work"]);
  assert.deepEqual(localCrumbs("/Users/me", "/Volumes/USB").map(c => c.label), ["/", "Volumes", "USB"]);
});

test("folders come first, numbers sort naturally", () => {
  const sorted = sortEntries([{ name: "b10", dir: false }, { name: "b2", dir: false }, { name: "z", dir: true }, { name: "A", dir: false }]);
  assert.deepEqual(sorted.map(e => e.name), ["z", "A", "b2", "b10"]);
});

test("empty folders of a folder upload are found", () => {
  assert.deepEqual(emptyFolders(["p", "p/src", "p/empty", "p/src/deep"], ["p/src/a.rs"]), ["p/empty", "p/src/deep"]);
});

test("a folder upload is one row with its total and worst state", () => {
  const t = (id, patch) => ({ id, machineId: "m", base: "b", kind: "upload", name: id, size: 10, sha256: "", bytes: 0, status: "queued", ...patch });
  const rows = transferRows([
    t("a", { group: "g", groupName: "project", bytes: 10, status: "running" }),
    t("b", { group: "g", groupName: "project", status: "failed", message: "disk full" }),
    t("c", { status: "done" }),
    t("d", { kind: "download", bytes: 5, status: "paused" }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[0], ids: undefined }, { key: "g", ids: undefined, kind: "upload", name: "project", count: 2, bytes: 10, size: 20, status: "failed", message: "disk full" });
  assert.equal(rows[1].status, "paused");
});
