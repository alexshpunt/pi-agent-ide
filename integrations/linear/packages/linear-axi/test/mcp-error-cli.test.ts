/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { createMcpRequestCountFixture } from "./fixtures/mcp-request-count.ts";

void test("the real CLI retains the specific missing-issue diagnosis without exposing the backend message", async (t) => {
  const fixture = await createMcpRequestCountFixture({
    mutationToolError: {
      error: "invalid_request",
      status: 400,
      message: "Could not find referenced Issue.",
    },
  });
  t.after(fixture.close);
  const invocation = await fixture.writeComment();
  assert.equal(invocation.error, "LINEAR_OPERATION_ISSUE_NOT_FOUND");
  assert.equal(invocation.effect, "unknown");
  assert.equal(fixture.snapshot().mutationAttempts, 1);
});
for (const [code, reason] of [
  ["invalid_request", "VALIDATION_FAILED"],
  ["invalid_token", "AUTH_REQUIRED"],
  ["FORBIDDEN", "PERMISSION_DENIED"],
  ["RATE_LIMITED", "RATE_LIMITED"],
] as const) {
  for (const structured of [false, true]) {
    void test(`the real CLI preserves ${structured ? "structured" : "JSON text"} MCP ${code} rejection without exposing its message or replaying`, async (t) => {
      const fixture = await createMcpRequestCountFixture({
        mutationToolError: { error: code, message: "private-server-details bearer-value" },
        mutationToolErrorStructured: structured,
      });
      t.after(fixture.close);
      const invocation = await fixture.writeComment();
      assert.equal(invocation.error, `LINEAR_OPERATION_${reason}`);
      assert.equal(invocation.effect, "unknown");
      assert.equal(invocation.data, "null");
      const counts = fixture.snapshot();
      assert.equal(counts.mutationAttempts, 1);
      assert.equal(counts.mutations, 0);
      assert.doesNotMatch(fixture.commandOutput(), /private-server-details|bearer-value/);
    });
  }
}
