import test from "node:test";
import assert from "node:assert/strict";
import { addressKind, addressLabel, baseUrl, currentAddress, needsPairing, pairMachine, tokenAccount } from "./machines.ts";

let n = 0;
const newId = () => `x${++n}`;

test("address kinds", () => {
  for (const lan of ["http://office-mac.local:8080", "http://192.168.1.20:8080", "http://10.0.0.2", "http://172.20.1.1", "http://[fd00::1]:8080"]) {
    assert.equal(addressKind(lan), "LAN", lan);
  }
  for (const remote of ["https://office.tail49e461.ts.net", "https://mob.example.com", "http://100.101.1.2:8080", "http://172.32.0.1"]) {
    assert.equal(addressKind(remote), "Remote", remote);
  }
});

test("pairing adds a second address to the same office", () => {
  const m = { id: "m", name: "Office", serverId: "S", addresses: [{ id: "m", url: "http://office.local:8080", clientId: "C1" }] };
  const { machine: two, address, dropped } = pairMachine(m, "https://office.tail.ts.net", "S", "C2", newId);
  assert.deepEqual(dropped, []);
  assert.deepEqual(two.addresses.map((a) => a.url), ["http://office.local:8080", "https://office.tail.ts.net"]);
  assert.equal(tokenAccount(two.addresses[0].id), "m.token", "the first address keeps its token");
  assert.notEqual(tokenAccount(address.id), "m.token", "each address has its own token");
  assert.equal(baseUrl(two), "https://office.tail.ts.net", "the new address is used");
  assert.deepEqual(two.addresses.map((a) => addressLabel(two, a)), ["LAN", "Remote"]);

  // The same address again is paired again, not added.
  const again = pairMachine(two, "https://office.tail.ts.net", "S", "C3", newId);
  assert.equal(again.machine.addresses.length, 2);
  assert.equal(again.address.id, address.id);
  assert.equal(currentAddress(again.machine).clientId, "C3");

  // Another office replaces the addresses (the user confirmed it) and drops their tokens.
  const other = pairMachine(two, "http://10.0.0.9:8080", "T", "D", newId);
  assert.deepEqual(other.machine.addresses.map((a) => a.url), ["http://10.0.0.9:8080"]);
  assert.equal(other.machine.addresses[0].id, "m");
  // m.token is overwritten by the new pairing, so only the other address's token goes.
  assert.deepEqual(other.dropped, [tokenAccount(address.id)]);
});

test("a machine from before pairing keeps only the new address", () => {
  const m = { id: "m", name: "Office", addresses: [{ id: "m", url: "http://old:8080", needsPairing: true }] };
  const { machine, address } = pairMachine(m, "http://new:8080", "S", "C", newId);
  assert.deepEqual(machine.addresses, [{ id: "m", url: "http://new:8080", clientId: "C", needsPairing: false }]);
  assert.equal(machine.route, address.id);
  assert.equal(machine.serverId, "S");
});

test("route labels and choice", () => {
  const m = { id: "m", name: "Office", addresses: [{ id: "m", url: "https://a.ts.net" }, { id: "b", url: "https://b.example.com" }] };
  assert.deepEqual(m.addresses.map((a) => addressLabel(m, a)), ["Remote", "Remote 2"]);
  m.addresses[1].label = "Cloudflare";
  assert.equal(addressLabel(m, m.addresses[1]), "Cloudflare");
  assert.equal(baseUrl(m), "https://a.ts.net", "the first address without a choice");
  m.route = "b";
  assert.equal(baseUrl(m), "https://b.example.com");
  m.addresses[1].needsPairing = true;
  assert.equal(needsPairing(m), true, "only the address in use counts");
  m.route = "gone";
  assert.equal(baseUrl(m), "https://a.ts.net");
  assert.equal(needsPairing(m), false);
  assert.equal(needsPairing(null), true);
});

test("one machine is this computer, listed first", async () => {
  const { markLocal, isLocal } = await import("./machines.ts");
  const a = { id: "a", name: "Office", addresses: [] };
  const b = { id: "b", name: "Laptop", addresses: [], local: true };
  const c = { id: "c", name: "Mac", addresses: [] };
  const out = markLocal([a, b, c], "c");
  assert.deepEqual(out.map((m) => m.id), ["c", "a", "b"]);
  assert.deepEqual(out.map(isLocal), [true, false, false]);
  assert.equal("local" in out[2], false);
  assert.equal(markLocal([a], "zz")[0], a);
});
