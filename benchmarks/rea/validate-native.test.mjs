import assert from "node:assert/strict";
import { test } from "node:test";
import { validateNative } from "./validate-native.mjs";

const digest = "a".repeat(64);
function evidence() {
  return {
    evidence_id: `ev_${digest}`,
    operation: "analyze_function",
    authority: "shipped-artifact",
    provider: { id: "ghidra" },
    subject: { digest: { sha256: digest } },
    normalized_result: {
      procedure: { name: "catalog_rank", body: { available: true, contains_entry: true } },
      pseudocode: "int catalog_rank(char *query) { return 0; }",
      assembly: ["0x1000: RET"],
      callers: [{ name: "main" }],
      callees: ["strlen", "tolower", "strcmp"].map((name) => ({ name: `<EXTERNAL>::${name}` })),
    },
  };
}

test("accepts a static dossier for the exact fixture artifact", () => {
  assert.equal(validateNative(evidence(), digest).passed, true);
});

test("rejects another binary even if its function has the same name", () => {
  assert.equal(validateNative(evidence(), "b".repeat(64)).passed, false);
});

test("rejects runtime authority and incomplete function bodies", () => {
  const runtime = evidence();
  runtime.authority = "runtime-observed";
  assert.equal(validateNative(runtime, digest).passed, false);
  const partial = evidence();
  partial.normalized_result.procedure.body.available = false;
  assert.equal(validateNative(partial, digest).passed, false);
});

test("does not award missing call edges or a failure envelope", () => {
  const missing = evidence();
  missing.normalized_result.callees = [];
  assert.equal(validateNative(missing, digest).passed, false);
  assert.equal(validateNative({ code: "cancelled" }, digest).passed, false);
});
