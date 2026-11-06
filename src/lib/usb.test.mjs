import test from "node:test";
import assert from "node:assert/strict";
import { active, deviceDetail, ids, shareBlocker, stateLabel, usbError } from "./usb.ts";

test("device details and states read plainly", () => {
  assert.equal(ids(0x1209, 1), "1209:0001");
  assert.equal(deviceDetail({ manufacturer: "Raspberry Pi", vendorId: 0x2e8a, productId: 0x000c }), "Raspberry Pi · 2e8a:000c");
  assert.equal(deviceDetail({ manufacturer: null, vendorId: 1, productId: 2 }), "0001:0002");
  assert.equal(stateLabel("connected", "3-1"), "Shared · 3-1 on the office computer");
  assert.equal(stateLabel("connecting"), "Connecting…");
  assert.ok(active("connected") && active("disconnecting") && !active("failed"));
});

test("shareBlocker: shared, held by the OS, or an importer that is not ready", () => {
  const d = { busId: "1-1", name: "Probe", vendorId: 1, productId: 2, shared: false };
  assert.equal(shareBlocker(d), "");
  assert.equal(shareBlocker({ ...d, shared: true }), "Already shared");
  assert.match(shareBlocker({ ...d, unavailable: "macOS's own driver holds drives" }), /driver/);
  assert.match(shareBlocker(d, { backend: "none", ready: false, detail: "run setup" }), /cannot import/);
  assert.equal(shareBlocker(d, { backend: "vhci", ready: true }), "");
});

test("usbError reads mobd's message and code", async () => {
  const busy = new Response(JSON.stringify({ error: "the device is in use: /dev/sdb1 is mounted at /mnt", code: "usb_busy" }), { status: 409 });
  assert.deepEqual(await usbError(busy), { message: "the device is in use: /dev/sdb1 is mounted at /mnt", code: "usb_busy" });
  assert.deepEqual(await usbError(new Response("oops", { status: 502 })), { message: "mobd answered 502" });
});
