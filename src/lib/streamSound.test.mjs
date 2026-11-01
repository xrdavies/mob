import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { configureAuth } from "./auth.ts";

// The live view's sound (docs/desktop-audio.md) against fake WebRTC: what is offered and asked
// for, the control messages, and the video element's mute state.

class FakeChannel {
  readyState = "connecting";
  sent = [];
  onmessage = null;
  onopen = null;
  constructor(label) { this.label = label; }
  send(data) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = "open"; this.onopen?.(); }
  receive(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

class FakePC {
  static last = null;
  transceivers = [];
  channels = {};
  listeners = {};
  iceGatheringState = "complete";
  connectionState = "new";
  localDescription = null;
  constructor() { FakePC.last = this; }
  addTransceiver(kind, init) { this.transceivers.push({ kind, ...init }); }
  createDataChannel(label) { return (this.channels[label] = new FakeChannel(label)); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  async createOffer() { return { type: "offer", sdp: this.transceivers.map((t) => `m=${t.kind}`).join("\r\n") }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription() {}
  async getStats() { return new Map(); }
  close() { this.connectionState = "closed"; }
}

function fakeVideo() {
  return {
    muted: true, srcObject: null, videoWidth: 1280, videoHeight: 720, onloadeddata: null, onresize: null,
    plays: 0, refuse: false,
    play() { this.plays++; return this.refuse && !this.muted ? Promise.reject(new Error("NotAllowed")) : Promise.resolve(); },
    addEventListener() {}, removeEventListener() {}, getBoundingClientRect() { return { left: 0, top: 0, width: 1, height: 1 }; },
    focus() {}, blur() {},
  };
}

async function setup(t, { features = ["stream", "streamAudio"], audio = { status: "ready", codec: "opus" } } = {}) {
  globalThis.RTCPeerConnection = FakePC;
  globalThis.performance ??= { now: () => Date.now() };
  globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
  globalThis.requestAnimationFrame ??= () => 0;
  globalThis.cancelAnimationFrame ??= () => {};
  configureAuth({ token: () => "t", unauthorized: () => {} });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (init?.method === "POST") requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ session: "s1", answer: "v=0", width: 1280, height: 720, audio }), { status: 201 });
  });
  const { stream } = await import("./stream.ts");
  const video = fakeVideo();
  const canvas = { ...fakeVideo(), width: 0, height: 0 };
  await stream.connect({ video, canvas }, { base: "http://office", health: { apiVersion: 3, features }, maxWidth: 1280, maxHeight: 720 });
  const pc = FakePC.last;
  pc.channels.control.open();
  video.onloadeddata(); // the first picture: WebRTC carries the session
  t.after(() => stream.disconnect());
  return { stream, video, pc, control: pc.channels.control, requests };
}

test("a view offers sound where mobd shares it, off until the user turns it on", async (t) => {
  const { stream, video, pc, control, requests } = await setup(t);
  assert.deepEqual(pc.transceivers.map((x) => [x.kind, x.direction]), [["video", "recvonly"], ["audio", "recvonly"]]);
  assert.equal(requests[0].audio, true);
  assert.equal(stream.state.status, "connected");
  assert.equal(stream.state.sound, "off");
  assert.equal(video.muted, true);
  assert.deepEqual(control.sent, [], "no sound before the user asks");

  stream.setSound(true);
  assert.equal(video.muted, false, "unmuted in the click");
  assert.deepEqual(control.sent, [{ t: "audio", on: true }]);
  assert.equal(stream.state.sound, "starting");
  control.receive({ t: "audio", state: "on" });
  assert.equal(stream.state.sound, "on");

  stream.setSound(false);
  assert.equal(video.muted, true);
  assert.deepEqual(control.sent.at(-1), { t: "audio", on: false });
  assert.equal(stream.state.sound, "off");
});

test("a reconnect in the same view keeps the sound on; closing the view turns it off", async (t) => {
  const { stream, video, control } = await setup(t);
  stream.setSound(true);
  control.receive({ t: "audio", state: "on" });
  // Reconnect (new size or quality): sound is asked for again as soon as the picture is back.
  await stream.connect({ video, canvas: fakeVideo() }, { base: "http://office", health: { apiVersion: 3, features: ["stream", "streamAudio"] }, maxWidth: 800, maxHeight: 500 });
  const again = FakePC.last.channels.control;
  again.open();
  video.onloadeddata();
  assert.deepEqual(again.sent, [{ t: "audio", on: true }]);
  assert.equal(stream.state.sound, "starting");
  stream.disconnect();
  await stream.connect({ video, canvas: fakeVideo() }, { base: "http://office", health: { apiVersion: 3, features: ["stream", "streamAudio"] }, maxWidth: 800, maxHeight: 500 });
  FakePC.last.channels.control.open();
  video.onloadeddata();
  assert.deepEqual(FakePC.last.channels.control.sent, [], "a new view starts with sound off");
  assert.equal(stream.state.sound, "off");
});

test("mobd's unavailable answers and errors leave the picture and explain", async (t) => {
  const { stream, video, control } = await setup(t);
  stream.setSound(true);
  control.receive({ t: "audio", state: "error", message: "sound ended: permission revoked" });
  assert.equal(stream.state.sound, "error");
  assert.match(stream.state.soundDetail, /permission revoked/);
  assert.equal(video.muted, true);
  assert.equal(stream.state.status, "connected");
});

test("no sound offered to an older mobd, and an unavailable answer says why", async (t) => {
  const old = await setup(t, { features: ["stream"] });
  assert.deepEqual(old.pc.transceivers.map((x) => x.kind), ["video"]);
  assert.equal(old.requests[0].audio, undefined);
  assert.equal(old.stream.state.sound, "none");
  old.stream.disconnect();
  const none = await setup(t, { audio: { status: "unavailable", reason: "This office computer cannot share its sound yet." } });
  assert.equal(none.stream.state.sound, "unavailable");
  assert.match(none.stream.state.soundDetail, /cannot share/);
});

test("a webview refusing audible playback after a reconnect falls back to muted", async (t) => {
  const { stream, video, control } = await setup(t);
  stream.setSound(true);
  video.muted = true; // as after a reconnect
  video.refuse = true;
  control.receive({ t: "audio", state: "on" });
  await setImmediate();
  await setImmediate();
  assert.equal(video.muted, true);
  assert.equal(stream.state.sound, "off");
  assert.match(stream.state.soundDetail, /Click the speaker/);
  assert.deepEqual(control.sent.at(-1), { t: "audio", on: false }, "mobd stops capturing");
});

test("through a Mob relay the view uses its STUN and TURN servers", async (t) => {
  globalThis.RTCPeerConnection = class extends FakePC {
    constructor(config) { super(); this.config = config; }
  };
  globalThis.performance ??= { now: () => Date.now() };
  configureAuth({ token: () => "t", unauthorized: () => {} });
  const urls = [];
  const ice = [{ urls: ["stun:relay.example.com:3478"] }, { urls: ["turn:relay.example.com:3478?transport=udp"], username: "1:office", credential: "c" }];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    if (String(url).endsWith("/stream/ice")) return new Response(JSON.stringify({ iceServers: ice, ttlSeconds: 43200 }));
    return new Response(JSON.stringify({ session: "s1", answer: "v=0", width: 1, height: 1 }), { status: 201 });
  });
  const { stream } = await import("./stream.ts");
  t.after(() => stream.disconnect());
  await stream.connect({ video: fakeVideo(), canvas: fakeVideo() }, { base: "http://office", health: { apiVersion: 3, features: ["stream", "streamIce"] }, maxWidth: 1, maxHeight: 1 });
  assert.deepEqual(FakePC.last.config, { iceServers: ice, iceTransportPolicy: "all" });
  assert.ok(urls[0].endsWith("/stream/ice") && urls[1].endsWith("/stream"), "ICE servers before the offer");
  stream.disconnect();
  urls.length = 0;
  await stream.connect({ video: fakeVideo(), canvas: fakeVideo() }, { base: "http://office", health: { apiVersion: 3, features: ["stream"] }, maxWidth: 1, maxHeight: 1 });
  assert.equal(FakePC.last.config, undefined, "an older mobd: host candidates only");
  assert.ok(!urls.some((u) => u.endsWith("/stream/ice")));
});
