/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decode } from "@toon-format/toon-v4";
import { fixtureRecord, jsonRecord } from "./fixtures/json.ts";
import {
  COMMENT_ID,
  PRIVATE_COMMENT_ERROR,
  commentCreateFixture,
  type CommentFixtureOutcome,
} from "./fixtures/comment-create.ts";

const create = ["comments", "create", "--issue", "ENG-12", "--body", "Fixture comment"];
const timeout = { timeout: 20_000 };
type Fixture = Awaited<ReturnType<typeof commentCreateFixture>>;
function failure(result: Awaited<ReturnType<Fixture["command"]>>) {
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout.includes(PRIVATE_COMMENT_ERROR), false);
  assert.equal(result.stderr.includes(PRIVATE_COMMENT_ERROR), false);
  const { error, effect } = fixtureRecord(
    decode(
      result.stdout
        .split("\n")
        .filter((line) => /^(?:error|effect):/u.test(line))
        .join("\n"),
    ),
  );
  assert(typeof error === "string");
  assert(typeof effect === "string");
  assert.match(error, /^LINEAR_[A-Z_]+$/u);
  return { error, effect };
}
function oneAttempt(fixture: Fixture) {
  assert.deepEqual(fixture.attempts, [
    { transport: "mcp", input: { issueId: "ENG-12", body: "Fixture comment" } },
  ]);
  assert.equal(fixture.observed.redirects, 0);
  assert.equal(fixture.observed.authorizationMismatches, 0);
}

for (const actor of ["user", "user-oauth", "unknown-oauth", "app"] as const) {
  for (const config of ["absent", "configured", "malformed", "unreadable"] as const) {
    void test(
      `selected ${actor} posts as itself with ${config} legacy persona settings`,
      timeout,
      async (t) => {
        const fixture = await commentCreateFixture(actor);
        t.after(() => fixture.close());
        const path = join(fixture.directory, "personas.json");
        const overrides: NodeJS.ProcessEnv = { LINEAR_AXI_MCP_TOKEN: "synthetic-unselected-key" };
        if (config !== "absent") {
          overrides.LINEAR_AXI_PERSONA_CONFIG = path;
          overrides.LINEAR_AXI_ROLE = "qa";
          if (config !== "unreadable")
            await writeFile(
              path,
              config === "malformed"
                ? "{invalid JSON"
                : JSON.stringify({ roles: { qa: { displayName: "Not the selected identity" } } }),
            );
        }
        const result = await fixture.command(create, overrides);
        assert.equal(result.exitCode, 0, result.stdout);
        const comment = fixtureRecord(fixtureRecord(decode(result.stdout)).comment);
        assert.equal(comment.id, COMMENT_ID);
        assert.equal(comment.author, actor === "app" ? "Fixture app" : "Fixture user");
        oneAttempt(fixture);
        assert.equal(
          fixture.observed.tokenExchanges,
          actor === "app" || actor === "user-oauth" ? 1 : 0,
        );
      },
    );
  }
}
void test(
  "default legacy persona configuration cannot change an App author",
  timeout,
  async (t) => {
    const fixture = await commentCreateFixture("app");
    t.after(() => fixture.close());
    const agentDirectory = fixture.environment.PI_CODING_AGENT_DIR;
    assert(agentDirectory);
    const directory = join(agentDirectory, "config", "linear-axi");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "personas.json"), "{invalid JSON");
    const result = await fixture.command(create);
    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(fixtureRecord(fixtureRecord(decode(result.stdout)).comment).author, "Fixture app");
    oneAttempt(fixture);
  },
);
const rejected: { outcome: CommentFixtureOutcome; code?: string }[] = [
  { outcome: "http-401", code: "LINEAR_OPERATION_AUTH_REQUIRED" },
  { outcome: "http-403", code: "LINEAR_OPERATION_PERMISSION_DENIED" },
  { outcome: "http-307" },
  { outcome: "forbidden", code: "LINEAR_OPERATION_PERMISSION_DENIED" },
  { outcome: "disconnect", code: "LINEAR_OPERATION_CONNECTION_FAILED" },
  { outcome: "invalid-receipt", code: "LINEAR_OPERATION_INVALID_RESPONSE" },
];
for (const { outcome, code } of rejected) {
  void test(
    `selected App ${outcome} dispatches once with bounded diagnostics and no fallback`,
    timeout,
    async (t) => {
      const fixture = await commentCreateFixture("app", { outcome });
      t.after(() => fixture.close());
      const result = await fixture.command(create);
      const error = failure(result);
      if (code) assert.equal(error.error, code);
      else
        assert.match(
          error.error,
          /^LINEAR_OPERATION_(?:BACKEND_REJECTED|INVALID_RESPONSE|UNKNOWN)$/u,
        );
      assert.equal(error.effect, "unknown");
      oneAttempt(fixture);
    },
  );
}
for (const outcome of ["success", "partial-success"] as const) {
  void test(
    `a ${outcome} acknowledgement retains its UUID without readback`,
    timeout,
    async (t) => {
      const fixture = await commentCreateFixture("app", { outcome, unavailableReadback: true });
      t.after(() => fixture.close());
      const result = await fixture.command(create);
      assert.equal(result.exitCode, 0, result.stdout);
      assert.equal(fixtureRecord(fixtureRecord(decode(result.stdout)).comment).id, COMMENT_ID);
      assert.equal(result.stdout.includes(PRIVATE_COMMENT_ERROR), false);
      oneAttempt(fixture);
      assert.equal(fixture.observed.readsAfterMutation, 0);
    },
  );
}
void test("a quota response retains retry timing without another attempt", timeout, async (t) => {
  const fixture = await commentCreateFixture("app", { outcome: "http-429" });
  t.after(() => fixture.close());
  const result = await fixture.command(create);
  assert.deepEqual(failure(result), { error: "LINEAR_OPERATION_RATE_LIMITED", effect: "unknown" });
  const row = fixtureRecord(
    decode(
      result.stdout
        .split("\n")
        .filter((line) => line.startsWith("rateLimit:"))
        .join("\n"),
    ),
  );
  assert.equal(jsonRecord(row.rateLimit).retryAfterMs, 37000);
  oneAttempt(fixture);
});
void test("a selected epoch mismatch is refused before mutation", timeout, async (t) => {
  const fixture = await commentCreateFixture("app");
  t.after(() => fixture.close());
  const result = await fixture.command(create, {
    LINEAR_AXI_AUTH_EPOCH: "00000000-0000-4000-8000-000000000000",
  });
  assert.equal(failure(result).effect, "not-applied");
  assert.deepEqual(fixture.attempts, []);
});
