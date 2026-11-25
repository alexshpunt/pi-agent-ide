/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { jsonRecord } from "./fixtures/json.ts";
import {
  createMcpRequestCountFixture,
  PRIVATE_RATE_LIMIT_BODY,
} from "./fixtures/mcp-request-count.ts";

for (const status of [401, 403, 307] as const) {
  void test(
    `a legacy OAuth mutation is not recovered or redirected after HTTP ${status}`,
    { timeout: 40_000 },
    async (t) => {
      const fixture = await createMcpRequestCountFixture({
        legacyOAuth: true,
        mutationFailure: status,
      });
      t.after(() => fixture.close());
      const result = await fixture.writeComment();
      const counts = fixture.snapshot();
      t.diagnostic(JSON.stringify({ status, error: result.error, effect: result.effect, counts }));
      assert.equal(result.effect, "unknown");
      assert.equal(
        result.error,
        status === 401
          ? "LINEAR_OPERATION_AUTH_REQUIRED"
          : status === 403
            ? "LINEAR_OPERATION_PERMISSION_DENIED"
            : "LINEAR_OPERATION_UNKNOWN",
      );
      assert.equal(counts.mutationAttempts, 1);
      assert.equal(counts.mutations, 0);
      assert.equal(counts.oauthRequestsAfterFailure, 0);
      assert.equal(counts.redirectedMutationRequests, 0);
      assert.ok(!fixture.commandOutput().includes(PRIVATE_RATE_LIMIT_BODY));
      assert.ok(!fixture.commandOutput().includes("synthetic-request-count-key"));
      assert.ok(!fixture.commandOutput().includes("synthetic-client-secret"));
      assert.ok(!fixture.commandOutput().includes("synthetic-refresh-key"));
    },
  );
}

void test(
  "a successful legacy OAuth mutation still executes once",
  { timeout: 40_000 },
  async (t) => {
    const fixture = await createMcpRequestCountFixture({ legacyOAuth: true });
    t.after(() => fixture.close());
    const result = await fixture.writeComment();
    const counts = fixture.snapshot();
    assert.equal(result.effect, "applied");
    assert.equal(result.error, undefined);
    assert.equal(jsonRecord(result.data).id, "b5d757b6-4c11-4ccd-8d0b-d939e06426d8");
    assert.equal(counts.mutationAttempts, 1);
    assert.equal(counts.mutations, 1);
    assert.equal(counts.oauthRequestsAfterFailure, 0);
    assert.equal(counts.redirectedMutationRequests, 0);
  },
);
