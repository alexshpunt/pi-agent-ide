/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { jsonRecord } from "./fixtures/json.ts";
import {
  createMcpRequestCountFixture,
  PRIVATE_RATE_LIMIT_BODY,
  subtractCounts,
} from "./fixtures/mcp-request-count.ts";

type Invocation = Record<string, unknown>;
function retryMetadata(invocation: Invocation) {
  const metadata = jsonRecord(invocation.rateLimit);
  const { retryAfterMs, resetAt, requestsLimit, requestsRemaining } = metadata;
  assert(typeof retryAfterMs === "number");
  assert.ok(retryAfterMs > 0 && retryAfterMs <= 60_000);
  assert(typeof resetAt === "number");
  assert.equal(requestsLimit, 2500);
  assert.equal(requestsRemaining, 0);
  return { retryAfterMs, resetAt, requestsLimit, requestsRemaining };
}
function assertReadRateLimit(invocation: Invocation) {
  assert.equal(invocation.operation, "get_project");
  assert.equal(invocation.effect, "not-applied");
  assert.equal(invocation.error, "LINEAR_OPERATION_RATE_LIMITED");
}

// Scope clock changes to the child CLI processes, never the fixture server or host.
function setCliClock(environment: NodeJS.ProcessEnv, now: number) {
  environment.NODE_OPTIONS = `--import=data:text/javascript,${encodeURIComponent(
    `Date.now = () => ${now};`,
  )}`;
}

for (const operation of ["get_project", "save_comment", "get_workflow_skill"] as const) {
  void test(
    `a backward wall-clock step cannot bypass the ${operation} cooldown`,
    { timeout: 40_000 },
    async (t) => {
      const fixture = await createMcpRequestCountFixture();
      t.after(() => fixture.close());
      // Keep the server's absolute reset header behind the CLI's relative Retry-After.
      const now = Date.now() + 60_000;
      setCliClock(fixture.environment, now);
      await fixture.readProject();
      const invoke = async () =>
        operation === "get_project"
          ? (await fixture.readProject()).invocation
          : operation === "save_comment"
            ? fixture.writeComment()
            : fixture.readNativeWorkflow();
      if (operation !== "get_workflow_skill") fixture.rateLimitNext(operation);
      const failed = await invoke();
      assert.equal(failed.operation, operation);
      assert.equal(failed.error, "LINEAR_OPERATION_RATE_LIMITED");
      const original = retryMetadata(failed);
      const afterRateLimit = fixture.snapshot();

      // Reproduce the observed ~1.3-second clock rollback between separate processes.
      setCliClock(fixture.environment, now - 1300);
      const blocked = await invoke();
      const delta = subtractCounts(fixture.snapshot(), afterRateLimit);
      t.diagnostic(JSON.stringify({ operation, clockRollbackMs: 1300, delta }));
      assert.equal(delta.httpRequests, 0);
      assert.equal(delta.mutationAttempts, 0);
      assert.equal(delta.mutations, 0);
      assert.equal(blocked.error, "LINEAR_OPERATION_RATE_LIMITED");
      // Mutation receipts stay conservative even when the local cooldown blocks transport.
      assert.equal(blocked.effect, operation === "save_comment" ? "unknown" : "not-applied");
      const metadata = retryMetadata(blocked);
      assert.equal(metadata.resetAt, original.resetAt);
      assert.ok(!fixture.commandOutput().includes(PRIVATE_RATE_LIMIT_BODY));
      assert.ok(!fixture.commandOutput().includes("synthetic-request-count-key"));
    },
  );
}
// The real CLI owns metadata, transport, receipt and cooldown behavior. Only Linear is replaced.
void test(
  "the CLI preserves safe server retry data without returning the private 429 body",
  { timeout: 40_000 },
  async (t) => {
    const fixture = await createMcpRequestCountFixture();
    t.after(() => fixture.close());
    await fixture.readProject();
    fixture.rateLimitNext();
    const failed = await fixture.readProject();
    t.diagnostic(
      JSON.stringify({
        receipt: {
          error: failed.invocation.error,
          effect: failed.invocation.effect,
          rateLimit: failed.invocation.rateLimit,
        },
        counts: fixture.snapshot(),
      }),
    );
    assertReadRateLimit(failed.invocation);
    const metadata = retryMetadata(failed.invocation);
    assert.ok(Math.abs(metadata.resetAt - fixture.rateLimitResetAt()) < 2000);
    assert.ok(!fixture.commandOutput().includes(PRIVATE_RATE_LIMIT_BODY));
    assert.ok(!fixture.commandOutput().includes("synthetic-request-count-key"));
  },
);

void test(
  "separate and concurrent CLI readers honor an existing cooldown without another HTTP request",
  { timeout: 50_000 },
  async (t) => {
    const fixture = await createMcpRequestCountFixture();
    t.after(() => fixture.close());
    await fixture.readProject();
    fixture.rateLimitNext();
    const failed = await fixture.readProject();
    assertReadRateLimit(failed.invocation);
    const afterRateLimit = fixture.snapshot();
    const blocked = await fixture.readProject();
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => fixture.readProject()));
    t.diagnostic(
      JSON.stringify({ initial: afterRateLimit, afterBlockedReaders: fixture.snapshot() }),
    );
    const delta = subtractCounts(fixture.snapshot(), afterRateLimit);
    assert.equal(delta.httpRequests, 0);
    assert.equal(delta.toolsList, 0);
    assert.equal(delta.workspace, 0);
    assert.equal(delta.project, 0);
    assert.equal(delta.initialize, 0);
    for (const result of [blocked, ...concurrent]) {
      assertReadRateLimit(result.invocation);
      const metadata = retryMetadata(result.invocation);
      assert.ok(metadata.resetAt > Date.now());
    }
    assert.ok(!fixture.commandOutput().includes(PRIVATE_RATE_LIMIT_BODY));
  },
);

void test(
  "a rate-limited mutation is not replayed and later explicit calls remain blocked by cooldown",
  { timeout: 40_000 },
  async (t) => {
    const fixture = await createMcpRequestCountFixture();
    t.after(() => fixture.close());
    await fixture.readProject();
    fixture.rateLimitNext("save_comment");
    const failed = await fixture.writeComment();
    assert.equal(failed.operation, "save_comment");
    assert.equal(failed.effect, "unknown");
    assert.equal(failed.error, "LINEAR_OPERATION_RATE_LIMITED");
    const afterRateLimit = fixture.snapshot();
    assert.equal(afterRateLimit.mutationAttempts, 1);
    assert.equal(afterRateLimit.mutations, 0);
    const blocked = await fixture.writeComment();
    t.diagnostic(
      JSON.stringify({ initial: afterRateLimit, afterExplicitMutation: fixture.snapshot() }),
    );
    const delta = subtractCounts(fixture.snapshot(), afterRateLimit);
    assert.equal(delta.httpRequests, 0);
    assert.equal(delta.mutationAttempts, 0);
    assert.equal(delta.mutations, 0);
    assert.equal(blocked.error, "LINEAR_OPERATION_RATE_LIMITED");
    retryMetadata(failed);
    retryMetadata(blocked);
    assert.ok(!fixture.commandOutput().includes(PRIVATE_RATE_LIMIT_BODY));
    assert.ok(!fixture.commandOutput().includes("synthetic-request-count-key"));
  },
);

void test(
  "native API reads share their own cooldown and preserve its safe receipt metadata",
  { timeout: 40_000 },
  async (t) => {
    const fixture = await createMcpRequestCountFixture();
    t.after(() => fixture.close());
    await fixture.readProject();
    const failed = await fixture.readNativeWorkflow();
    assert.equal(failed.error, "LINEAR_OPERATION_RATE_LIMITED");
    retryMetadata(failed);
    const after = fixture.snapshot();
    assert.equal(after.nativeRequests, 1);
    const blocked = await fixture.readNativeWorkflow();
    assert.equal(blocked.error, "LINEAR_OPERATION_RATE_LIMITED");
    retryMetadata(blocked);
    assert.equal(fixture.snapshot().httpRequests, after.httpRequests);
    assert.equal(fixture.snapshot().nativeRequests, 1);
    assert.ok(!fixture.commandOutput().includes(PRIVATE_RATE_LIMIT_BODY));
  },
);

void test(
  "GraphQL body rate signals honor Retry-After even without quota counters",
  { timeout: 40_000 },
  async (t) => {
    const fixture = await createMcpRequestCountFixture({ nativeQuotaHeaders: false });
    t.after(() => fixture.close());
    await fixture.readProject();
    const failed = await fixture.readNativeWorkflow();
    assert.equal(failed.error, "LINEAR_OPERATION_RATE_LIMITED");
    const metadata = jsonRecord(failed.rateLimit);
    assert.equal(metadata.retryAfterMs, 60000);
    assert.equal(metadata.requestsRemaining, undefined);
    const after = fixture.snapshot();
    const blocked = await fixture.readNativeWorkflow();
    assert.equal(blocked.error, "LINEAR_OPERATION_RATE_LIMITED");
    assert.equal(fixture.snapshot().httpRequests, after.httpRequests);
    assert.equal(fixture.snapshot().nativeRequests, 1);
    assert.ok(!fixture.commandOutput().includes(PRIVATE_RATE_LIMIT_BODY));
  },
);

for (const structured of [false, true]) {
  void test(
    `MCP body rate signals share cooldown across CLI calls (structured=${structured})`,
    { timeout: 40000 },
    async (t) => {
      const fixture = await createMcpRequestCountFixture({
        mutationToolErrorStructured: structured,
        mutationToolError: {
          code: "RATELIMITED",
          message: PRIVATE_RATE_LIMIT_BODY,
          rateLimit: { retryAfterMs: 60000, requestsLimit: 2500, requestsRemaining: 0 },
        },
      });
      t.after(() => fixture.close());
      await fixture.readProject();
      const failed = await fixture.writeComment();
      assert.equal(failed.effect, "unknown");
      assert.equal(failed.error, "LINEAR_OPERATION_RATE_LIMITED");
      const after = fixture.snapshot();
      const blocked = await fixture.writeComment();
      assert.equal(blocked.error, "LINEAR_OPERATION_RATE_LIMITED");
      assert.equal(blocked.effect, "unknown");
      assert.equal(subtractCounts(fixture.snapshot(), after).httpRequests, 0);
      assert.equal(fixture.snapshot().mutationAttempts, 1);
      assert.equal(fixture.snapshot().mutations, 0);
      retryMetadata(blocked);
      assert.ok(!fixture.commandOutput().includes(PRIVATE_RATE_LIMIT_BODY));
      const readers = await Promise.all(Array.from({ length: 20 }, () => fixture.readProject()));
      for (const result of readers) assertReadRateLimit(result.invocation);
      assert.equal(subtractCounts(fixture.snapshot(), after).httpRequests, 0);
    },
  );
}
