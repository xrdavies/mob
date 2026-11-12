import test from "node:test";
import assert from "node:assert/strict";
import { defaultLabel } from "./utils.ts";

test("the default choice names the agent's default when mobd reports it", () => {
  assert.equal(defaultLabel("effort", "xhigh"), "Default (xhigh)");
  assert.equal(defaultLabel("model", "gpt-6-astra"), "Default (gpt-6-astra)");
  assert.equal(defaultLabel("effort"), "Default effort");
});

test("mobd versions compare as numbers", async () => {
  const { newerVersion } = await import("./utils.ts");
  assert.equal(newerVersion("0.5.10", "0.5.9"), true);
  assert.equal(newerVersion("0.6.0", "0.5.12"), true);
  assert.equal(newerVersion("0.5.1", "0.5.1"), false);
  assert.equal(newerVersion("0.5.1", "0.6.0"), false);
  assert.equal(newerVersion("0.5.1", undefined), false);
});
