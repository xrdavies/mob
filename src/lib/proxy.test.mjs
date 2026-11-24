import test from "node:test";
import assert from "node:assert/strict";
import { isTailnetOrigin, proxyBlocksTailnet } from "./proxy.ts";

test("recognises Tailscale addresses", () => {
  for (const o of ["https://office.tail49e461.ts.net", "https://OFFICE.tail1.TS.NET:443", "http://100.120.57.121:8080", "http://100.127.255.255"]) assert.ok(isTailnetOrigin(o), o);
  for (const o of ["http://100.63.0.1:8080", "http://100.128.0.1", "https://mob.example.com", "https://notts.net", "http://192.168.1.5:8080", "bad"]) assert.ok(!isTailnetOrigin(o), o);
});

test("a proxy blocks Tailscale unless its bypass list covers the address", () => {
  const name = "https://office.tail1.ts.net", ip = "http://100.120.57.121:8080";
  const off = { enabled: false, bypass: [] };
  const lan = { enabled: true, bypass: ["127.0.0.1", "192.168.0.0/16", "10.0.0.0/8", "*.local", "<local>"] };
  assert.ok(!proxyBlocksTailnet(off, name) && !proxyBlocksTailnet(null, name));
  assert.ok(proxyBlocksTailnet(lan, name) && proxyBlocksTailnet(lan, ip));
  assert.ok(!proxyBlocksTailnet(lan, "http://192.168.1.5:8080"), "only Tailscale addresses get the hint");
  for (const entry of ["*.ts.net", ".ts.net", "ts.net", "tail1.ts.net"]) assert.ok(!proxyBlocksTailnet({ enabled: true, bypass: [entry] }, name), entry);
  for (const entry of ["100.64.0.0/10", "100.*", "100.120.57.121"]) assert.ok(!proxyBlocksTailnet({ enabled: true, bypass: [entry] }, ip), entry);
  assert.ok(proxyBlocksTailnet({ enabled: true, bypass: ["*.ts.net"] }, ip), "a name entry does not cover an IP");
  assert.ok(proxyBlocksTailnet({ enabled: true, bypass: ["100.0.0.0/16"] }, ip));
});
