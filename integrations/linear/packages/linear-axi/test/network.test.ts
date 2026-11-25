/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { CONNECT_ATTEMPT_TIMEOUT_MS, configureNetwork } from "#axi/lib/network.ts";

void test("the per-address connect budget is raised above Node's 250 ms default", (t) => {
  const original = net.getDefaultAutoSelectFamilyAttemptTimeout();
  t.after(() => net.setDefaultAutoSelectFamilyAttemptTimeout(original));
  net.setDefaultAutoSelectFamilyAttemptTimeout(250);
  configureNetwork();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), CONNECT_ATTEMPT_TIMEOUT_MS);
  assert.equal(CONNECT_ATTEMPT_TIMEOUT_MS, 2000);
});

void test("a larger budget set with Node's flag is kept", (t) => {
  const original = net.getDefaultAutoSelectFamilyAttemptTimeout();
  t.after(() => net.setDefaultAutoSelectFamilyAttemptTimeout(original));
  net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
  configureNetwork();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 5000);
});
