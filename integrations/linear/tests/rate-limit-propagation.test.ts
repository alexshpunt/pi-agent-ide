import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { ResourceError } from "pi-agent-ide/api/resource";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runAxi } from "#linear/axi.ts";
import { createLinearOperationBackend } from "#linear/operation-backend.ts";
import { readLinearDomain } from "#linear/domain-read.ts";
import { createLinearFields } from "#linear/fields.ts";
import { connectLinearReadErrorGuidance } from "#linear/read-error-guidance.ts";
import { createLinearResolver } from "#linear/read.ts";
import { createLinearTextBackend } from "#linear/text-backend.ts";

const source = "linear://example/project/cc4a56e3-8306-4f29-a859-bbc94618630c";
const rateLimit = {
  retryAfterMs: 37_000,
  resetAt: 1_900_000_037_000,
  requestsLimit: 2500,
  requestsRemaining: 0,
  complexityLimit: 3_000_000,
  complexityRemaining: 23,
  endpointLimit: 100,
  endpointRemaining: 0,
  endpoint: "get_project",
};
const untrustedRate = {
  ...rateLimit,
  authorization: "fixture-private-authorization",
  body: "fixture-private-body",
};
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "linear-rate-frontend-"));
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(
    path.join(cwd, ".pi", "linear.json"),
    JSON.stringify({
      axiPath: fileURLToPath(
        import.meta.resolve("#linear-tests/fixtures/rate-limit-frontend-cli.mjs"),
      ),
    }),
  );
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
async function scenario(mode: string, value: unknown = JSON.stringify(untrustedRate)) {
  await writeFile(
    path.join(cwd, "rate-limit-scenario.json"),
    JSON.stringify({ mode, rateLimit: value }),
  );
}
async function calls() {
  return (await readFile(path.join(cwd, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line) as unknown);
}

test("CLI failures retain only safe server timing through the capability boundary without another call", async () => {
  await scenario("preflight");
  await expect(
    runAxi(cwd, ["resources", "capabilities", "--workspace", "example"]),
  ).rejects.toMatchObject({
    message: "LINEAR_CAPABILITIES_RATE_LIMITED",
    rateLimit,
  });
  const error = await createLinearOperationBackend()
    .capabilities("example", cwd)
    .catch((value: unknown) => value);
  expect(error).toMatchObject({
    code: "LINEAR_CAPABILITIES_RATE_LIMITED",
    effect: "not-applied",
    rateLimit,
  });
  expect(error).toHaveProperty("rateLimit", rateLimit);
  expect(JSON.stringify(error)).not.toContain("fixture-private");
  expect(await calls()).toHaveLength(2);
});

test("operation receipts decode safe retry metadata and retain the backend effect", async () => {
  await scenario("operation");
  const result = await createLinearOperationBackend().invoke(
    "example",
    "get_project",
    { query: "project" },
    cwd,
  );
  expect(result).toEqual({
    workspace: "example",
    operation: "get_project",
    effect: "not-applied",
    error: "LINEAR_OPERATION_RATE_LIMITED",
    data: null,
    rateLimit,
  });
  expect(await calls()).toHaveLength(1);
});

test.each(["card", "fields"])(
  "a %s read retains server timing when converting a receipt into a resource error",
  async (surface) => {
    await scenario("operation");
    const backend = createLinearOperationBackend();
    const operation =
      surface === "card"
        ? readLinearDomain(source, cwd, undefined, backend)
        : createLinearFields(backend).read(source + "#fields", cwd);
    const error = await operation.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ResourceError);
    expect(error).toMatchObject({
      code: "LINEAR_OPERATION_RATE_LIMITED",
      effect: "not-applied",
      rateLimit,
    });
    expect(error).toHaveProperty("rateLimit", rateLimit);
    expect(await calls()).toHaveLength(2);
  },
);

test.each([
  ["not-json", undefined],
  [
    JSON.stringify({
      retryAfterMs: -1,
      resetAt: -1,
      requestsRemaining: 0.5,
      endpoint: "private / body",
    }),
    undefined,
  ],
  [
    JSON.stringify({
      retryAfterMs: 86_400_001,
      requestsLimit: Number.MAX_SAFE_INTEGER + 1,
      endpoint: "x".repeat(81),
    }),
    undefined,
  ],
  [
    JSON.stringify({ retryAfterMs: 0, resetAt: 0, requestsRemaining: 0, endpoint: "get_project" }),
    { retryAfterMs: 0, resetAt: 0, requestsRemaining: 0, endpoint: "get_project" },
  ],
  [
    JSON.stringify({
      retryAfterMs: 500,
      resetAt: null,
      requestsRemaining: -1,
      endpoint: "get_project",
    }),
    { retryAfterMs: 500, endpoint: "get_project" },
  ],
])(
  "malformed or out-of-bounds rate metadata is filtered at the receipt boundary: %s",
  async (input, expected) => {
    await scenario("operation", input);
    const receipt = await createLinearOperationBackend().invoke("example", "get_project", {}, cwd);
    expect(receipt.rateLimit).toEqual(expected);
    expect(receipt.effect).toBe("not-applied");
    expect(receipt.error).toBe("LINEAR_OPERATION_RATE_LIMITED");
  },
);

test.each(["LINEAR_OPERATION_RATE_LIMITED", "LINEAR_RATE_LIMITED"])(
  "Read guidance carries safe retry data without exposing private fields: %s",
  async (code) => {
    let listener: ExtensionHandler<ToolResultEvent, ToolResultEventResult> | undefined;
    connectLinearReadErrorGuidance({
      on(name: string, handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>) {
        if (name === "tool_result") listener = handler;
        return () => {};
      },
    } as ExtensionAPI);
    if (!listener) throw new Error("Missing Read result hook");
    const cause = new ResourceError(code, source, "not-applied", {
      metadata: { rateLimit: untrustedRate },
    });
    const result = await listener(
      {
        type: "tool_result",
        toolCallId: "fixture-read",
        input: { path: source },
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: code }],
        details: { failure: { source, cause } },
        structuredContent: { status: "error", errors: [{ code, source, message: code }] },
      },
      {} as ExtensionContext,
    );
    expect(result?.structuredContent).toMatchObject({
      errors: [
        {
          code,
          source,
          metadata: { rateLimit },
        },
      ],
    });
    expect(result?.structuredContent).toHaveProperty("errors.0.metadata.rateLimit", rateLimit);
    const first = result?.content?.[0];
    expect(first?.type === "text" ? first.text : "").toContain(
      String(Math.ceil(rateLimit.retryAfterMs / 1000)),
    );
    expect(JSON.stringify(result)).not.toContain("fixture-private");
    expect(cause.effect).toBe("not-applied");
  },
);

test("native Read wrapping retains safe timing from the CLI failure", async () => {
  await scenario("operation");
  const resolver = createLinearResolver(async () => {
    await runAxi(cwd, ["issues", "view", "ENG-12", "--full"]);
    throw new Error("unreachable");
  });
  const resolution = await resolver.tryResolve("https://linear.app/example/issue/ENG-12/fixture", {
    cwd,
  });
  expect(resolution.kind).toBe("resolved");
  if (resolution.kind !== "resolved" || !resolution.resource.read)
    throw new Error("fixture did not resolve");
  const error = await resolution.resource.read({}).catch((value: unknown) => value);
  expect(error).toMatchObject({
    code: "LINEAR_OPERATION_RATE_LIMITED",
    effect: "not-applied",
    rateLimit,
  });
  expect(error).toHaveProperty("rateLimit", rateLimit);
  expect(await calls()).toHaveLength(1);
});

test("a body-save preflight preserves safe timing without starting a mutation", async () => {
  await scenario("operation");
  const backend = createLinearTextBackend();
  const address = {
    kind: "issue-description",
    workspace: "example",
    identifier: "ENG-12",
    source: "linear://example/issue/ENG-12/description",
  } as const;
  const error = await backend
    .save(address, "Unchanged body", "Updated body", cwd)
    .catch((value: unknown) => value);
  expect(error).toMatchObject({
    code: "LINEAR_OPERATION_RATE_LIMITED",
    effect: "not-applied",
    rateLimit,
  });
  expect(error).toHaveProperty("rateLimit", rateLimit);
  expect(await calls()).toEqual([{ group: "issues", action: "view", operation: "ENG-12" }]);
});
