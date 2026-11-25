import { required } from "./fixtures/check.ts";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createLinearApiExecutor } from "#linear/api-backend.ts";
import { linearResourceError } from "#linear/resource-failure.ts";

const request = {
  query: "query Fixture($id: String!) { fixture(id: $id) }",
  variables: { id: "fixture-1" },
  operationName: "Fixture",
};
const receipt = {
  workspace: "example",
  operationType: "query",
  status: 200,
  ok: true,
  outcome: "success",
  effect: "not-applied",
  data: { fixture: "Saved fixture" },
  errors: [],
  extensions: { traceId: "fixture-trace" },
};

test("the native gateway receives original JSON through a private file and returns its complete response", async () => {
  let file = "";
  let directory = "";
  const signal = new AbortController().signal;
  const run = vi.fn(async (cwd: string, args: readonly string[], passedSignal?: AbortSignal) => {
    expect(cwd).toBe("/fixture-project");
    expect(passedSignal).toBe(signal);
    expect(args.slice(0, 5)).toEqual(["api", "graphql", "--workspace", "example", "--input-file"]);
    expect(args).toHaveLength(6);
    file = required(args[5]);
    directory = path.dirname(file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(request);
    return JSON.stringify({ graphql: receipt });
  });
  const actual = await createLinearApiExecutor(run)("example", request, "/fixture-project", signal);
  expect(actual).toEqual(receipt);
  expect(run).toHaveBeenCalledOnce();
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  "https://untrusted.invalid",
  "example/other",
  "example --token=fixture",
  "",
  [".".repeat(2), "example"].join("/"),
  "--help",
  "-fixture",
  "x".repeat(257),
])("an invalid workspace cannot become a CLI argument: %j", async (workspace) => {
  const run = vi.fn(async () => JSON.stringify({ graphql: receipt }));
  await expect(createLinearApiExecutor(run)(workspace, request, ".")).rejects.toMatchObject({
    effect: "not-applied",
  });
  expect(run).not.toHaveBeenCalled();
});

test.each([
  { ...request, endpoint: "https://untrusted.invalid/graphql" },
  { ...request, headers: { authorization: "Caller fixture" } },
  { ...request, token: "Caller fixture" },
  { ...request, variables: [] },
  { ...request, operationName: "Invalid name" },
  { query: " " },
])("invalid request overrides refuse before dispatch: %j", async (input) => {
  const run = vi.fn(async () => JSON.stringify({ graphql: receipt }));
  await expect(createLinearApiExecutor(run)("example", input, ".")).rejects.toMatchObject({
    effect: "not-applied",
  });
  expect(run).not.toHaveBeenCalled();
});

test("an oversized request refuses before dispatch", async () => {
  const run = vi.fn(async () => JSON.stringify({ graphql: receipt }));
  await expect(
    createLinearApiExecutor(run)("example", { query: "x".repeat(2 * 1024 * 1024) }, "."),
  ).rejects.toMatchObject({ code: "LINEAR_CONTENT_TOO_LARGE", effect: "not-applied" });
  expect(run).not.toHaveBeenCalled();
});

test.each([
  "private invalid output",
  JSON.stringify({ graphql: [] }),
  JSON.stringify({ graphql: { ...receipt, workspace: "other" } }),
  JSON.stringify({ graphql: receipt, credential: "Private fixture" }),
  JSON.stringify({ graphql: receipt }) + "x",
  "x".repeat(2 * 1024 * 1024 + 1),
])("a malformed or mismatched response stays unknown without replay", async (output) => {
  let directory = "";
  const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
    directory = path.dirname(required(args[5]));
    return output;
  });
  await expect(createLinearApiExecutor(run)("example", request, ".")).rejects.toMatchObject({
    code: "LINEAR_GRAPHQL_INVALID_RECEIPT",
    effect: "unknown",
  });
  expect(run).toHaveBeenCalledOnce();
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a cancelled request never dispatches", async () => {
  const controller = new AbortController();
  controller.abort();
  const run = vi.fn(async () => JSON.stringify({ graphql: receipt }));
  await expect(
    createLinearApiExecutor(run)("example", request, ".", controller.signal),
  ).rejects.toMatchObject({ effect: "not-applied" });
  expect(run).not.toHaveBeenCalled();
});

test("a partial response retains both saved data and GraphQL errors", async () => {
  const partial = {
    ...receipt,
    operationType: "mutation",
    effect: "unknown",
    ok: false,
    outcome: "partial",
    data: { saved: { id: "fixture-1" } },
    errors: [{ message: "Fixture branch", path: ["later"] }],
  };
  const run = vi.fn(async () => JSON.stringify({ graphql: partial }));
  expect(await createLinearApiExecutor(run)("example", request, ".")).toEqual(partial);
  expect(run).toHaveBeenCalledOnce();
});

test("a process failure cleans the input, hides private text and remains unknown", async () => {
  let directory = "";
  const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
    directory = path.dirname(required(args[5]));
    throw new Error("Private process output: fixture-secret");
  });
  let error: unknown;
  try {
    await createLinearApiExecutor(run)("example", request, ".");
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: "LINEAR_GRAPHQL_GATEWAY_FAILED", effect: "unknown" });
  expect(String(error)).not.toContain("fixture-secret");
  expect(run).toHaveBeenCalledOnce();
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["not-applied", "unknown", "applied"] as const)(
  "a known resource error retains its effect and safe rate-limit metadata: %s",
  async (effect) => {
    const original = linearResourceError(
      "LINEAR_OPERATION_RATE_LIMITED",
      "linear://example",
      effect,
      { retryAfterMs: 1234, requestsRemaining: 0, authorization: "Private fixture" },
    );
    const run = vi.fn(async () => {
      throw original;
    });
    await expect(createLinearApiExecutor(run)("example", request, ".")).rejects.toMatchObject({
      code: original.code,
      effect,
      metadata: { rateLimit: { retryAfterMs: 1234, requestsRemaining: 0 } },
    });
    expect(run).toHaveBeenCalledOnce();
  },
);

test("a safe process code is preserved without turning unknown effects into not-applied", async () => {
  const run = vi.fn(async () => {
    throw new Error("LINEAR_OPERATION_CONNECTION_CHANGED");
  });
  await expect(createLinearApiExecutor(run)("example", request, ".")).rejects.toMatchObject({
    code: "LINEAR_OPERATION_CONNECTION_CHANGED",
    effect: "unknown",
  });
  expect(run).toHaveBeenCalledOnce();
});
