import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpData } from "./mcp-data.mjs";

test("uses structured success data, not the text preview", () => {
  const value = { evidence_id: "owned-record" };
  assert.equal(
    mcpData({ structuredContent: value, content: [{ type: "text", text: "preview" }] }),
    value,
  );
});

test("preserves a text-only REA tool error", () => {
  const error = {
    code: "evidence_integrity_mismatch",
    details: { reason: "missing", evidence_id: "old-record" },
  };
  assert.deepEqual(
    mcpData({ isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] }),
    error,
  );
});

test("rejects missing structured success and ambiguous error blocks", () => {
  assert.throws(() => mcpData({ content: [{ type: "text", text: "{}" }] }));
  assert.throws(() => mcpData({ isError: true, content: [] }));
  assert.throws(() => mcpData({ isError: true, content: [{ type: "text", text: "{}" }] }));
});
