import { required } from "./fixtures/check.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { encode } from "@toon-format/toon-v4";
import { decodeIssue } from "#linear/axi.ts";
import { createLinearTextBackend } from "#linear/text-backend.ts";
import { createLinearAuthBoundary } from "#linear/auth-boundary.ts";
import { createLinearTextCreationHandler } from "#linear/text-create.ts";
import { linearErrorRateLimit, linearResourceError } from "#linear/resource-failure.ts";
interface CommentFixture {
  directory: string;
  environment: NodeJS.ProcessEnv;
  attempts: { transport: "mcp" | "native"; input: Record<string, unknown> }[];
  close(): Promise<void>;
}
// The backend has separate compiler settings; load its actual protocol fixture at runtime.
const fixturePath = fileURLToPath(
  import.meta.resolve("#linear-axi/test/fixtures/comment-create.ts"),
);
const { COMMENT_ID, COMMENT_WORKSPACE, PRIVATE_COMMENT_ERROR, commentCreateFixture } =
  (await import(fixturePath)) as {
    COMMENT_ID: string;
    COMMENT_WORKSPACE: string;
    PRIVATE_COMMENT_ERROR: string;
    commentCreateFixture(): Promise<CommentFixture>;
  };

const path = `linear://${COMMENT_WORKSPACE}/issue/ENG-12/comments/new`;
// Each creation starts the backend CLI cold, which takes seconds on a loaded machine; the CLI's
// own 30 s limit still ends a backend that never starts.
const LOADED_TEST_MS = 60_000;

test("raw issue UUIDs retain their correlated identifier and reject conflicting identities", () => {
  const id = "afe17780-2fd9-4b03-bd81-c79199a6c4e5";
  const source = `https://linear.app/${COMMENT_WORKSPACE}/issue/ENG-12`;
  const row = {
    id,
    identifier: "ENG-12",
    title: "Fixture",
    url: `https://linear.app/${COMMENT_WORKSPACE}/issue/ENG-12/fixture`,
  };
  expect(decodeIssue(encode({ issue: row }), source)).toMatchObject({ id: "ENG-12", uuid: id });
  for (const mismatch of [
    { ...row, identifier: "OTHER-1" },
    { ...row, id: "OTHER-1" },
    { ...row, uuid: "923d03f4-e079-4317-93b2-5fa5da991094" },
  ]) {
    expect(() => decodeIssue(encode({ issue: mismatch }), source)).toThrow(
      "LINEAR_IDENTITY_MISMATCH",
    );
  }
});
afterEach(() => vi.unstubAllEnvs());

function useEnvironment(environment: NodeJS.ProcessEnv) {
  for (const name of Object.keys(process.env)) {
    if (/^(?:LINEAR_|PI_|CODEX|XDG_)/u.test(name)) vi.stubEnv(name, undefined);
  }
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
}

function creationHandler(environment: NodeJS.ProcessEnv) {
  return createLinearAuthBoundary({
    // Model session selection only. The real CLI verifies this non-default grant and epoch.
    readEpoch: async () => ({
      connectionId: required(environment.LINEAR_AXI_CONNECTION_ID),
      epoch: required(environment.LINEAR_AXI_AUTH_EPOCH),
      state: "connected",
    }),
    onChange: () => {},
  }).semantic(createLinearTextCreationHandler(createLinearTextBackend().create));
}
test.each([undefined, "qa"])(
  "contextual creation uses the real selected-user backend and retains its acknowledged identity (ambient role=%s)",
  async (role) => {
    const fixture = await commentCreateFixture();
    try {
      useEnvironment(fixture.environment);
      if (role) vi.stubEnv("PI_SUBAGENT_AGENT", role);
      const handler = creationHandler(fixture.environment);
      const result = await handler.execute(
        { cwd: fixture.directory, sourceDocument: { content: "" } },
        { path, content: "Fixture comment" },
      );
      expect(result.data).toMatchObject({
        effect: "applied",
        id: COMMENT_ID,
        source: `linear://${COMMENT_WORKSPACE}/issue/ENG-12/comment/${COMMENT_ID}`,
      });
      expect(fixture.attempts).toEqual([
        { transport: "mcp", input: { issueId: "ENG-12", body: "Fixture comment" } },
      ]);
      expect(JSON.stringify(result)).not.toContain(PRIVATE_COMMENT_ERROR);
    } finally {
      await fixture.close();
    }
  },
  LOADED_TEST_MS,
);

test.each(["config", "role"])(
  "a selected user writes under their actual identity despite configured app persona (%s)",
  async (mode) => {
    const fixture = await commentCreateFixture();
    try {
      useEnvironment(fixture.environment);
      if (mode === "config") {
        const config = join(fixture.directory, "personas.json");
        await writeFile(
          config,
          JSON.stringify({ roles: { pi: { agentId: "pi", displayName: "Explicit persona" } } }),
        );
        vi.stubEnv("LINEAR_AXI_PERSONA_CONFIG", config);
      } else {
        vi.stubEnv("PI_SESSION_ID", undefined);
        vi.stubEnv("LINEAR_AXI_ROLE", "qa");
      }
      const handler = creationHandler(fixture.environment);
      const result = await handler.execute(
        { cwd: fixture.directory, sourceDocument: { content: "" } },
        { path, content: "Fixture comment" },
      );
      expect(result.data).toMatchObject({
        effect: "applied",
        id: COMMENT_ID,
        source: `linear://${COMMENT_WORKSPACE}/issue/ENG-12/comment/${COMMENT_ID}`,
      });
      expect(fixture.attempts).toEqual([
        { transport: "mcp", input: { issueId: "ENG-12", body: "Fixture comment" } },
      ]);
    } finally {
      await fixture.close();
    }
  },
  LOADED_TEST_MS,
);

test.each(["workspace", "connection", "epoch"])(
  "a mismatched %s refuses contextual creation before mutation",
  async (mismatch) => {
    const fixture = await commentCreateFixture();
    try {
      useEnvironment(fixture.environment);
      const environment = { ...fixture.environment };
      const foreign = "99635fc1-afb0-4223-8e48-f24021ff52aa";
      if (mismatch === "connection") environment.LINEAR_AXI_CONNECTION_ID = foreign;
      if (mismatch === "epoch") environment.LINEAR_AXI_AUTH_EPOCH = foreign;
      const requested =
        mismatch === "workspace" ? path.replace(COMMENT_WORKSPACE, "other-workspace") : path;
      const handler = creationHandler(environment);
      await expect(
        handler.execute(
          { cwd: fixture.directory, sourceDocument: { content: "" } },
          { path: requested, content: "Must not be sent." },
        ),
      ).rejects.toMatchObject({ effect: "not-applied", source: requested });
      expect(fixture.attempts).toEqual([]);
    } finally {
      await fixture.close();
    }
  },
  LOADED_TEST_MS,
);
test("the creation boundary retains bounded retry metadata with its owning failure", async () => {
  const rateLimit = { retryAfterMs: 37_000, requestsRemaining: 0, endpoint: "commentCreate" };
  const error = linearResourceError("LINEAR_OPERATION_RATE_LIMITED", "linear://", "unknown", {
    ...rateLimit,
    authorization: PRIVATE_COMMENT_ERROR,
  });
  const handler = createLinearTextCreationHandler(async () => {
    throw error;
  });
  const failure = await Promise.resolve(
    handler.execute({ cwd: process.cwd() } as never, { path, content: "Fixture comment" }),
  ).catch((value: unknown) => value);
  expect(failure).toMatchObject({
    code: "LINEAR_OPERATION_RATE_LIMITED",
    effect: "unknown",
    source: path,
  });
  expect(linearErrorRateLimit(failure)).toEqual(rateLimit);
  expect(JSON.stringify(failure)).not.toContain(PRIVATE_COMMENT_ERROR);
});
