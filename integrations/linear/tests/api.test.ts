import { jsonRecord } from "./fixtures/check.ts";
import { expect, test, vi } from "vitest";
import { createLinearApi } from "#linear/api.ts";
import { ResourceError } from "pi-agent-ide/api/resource";

test("a known applied effect survives a later gateway failure", async () => {
  const execute = vi.fn(async () => {
    throw new ResourceError("LINEAR_POST_WRITE_FAILED", "linear://example/api/graphql", "applied");
  });
  const result = await createLinearApi(execute).submit(
    "linear://example/api/graphql",
    '{"query":"mutation { fixture }"}',
    ".",
  );
  expect(result.data).toMatchObject({
    ok: false,
    effect: "applied",
    outcome: "error",
    error: "LINEAR_POST_WRITE_FAILED",
  });
  expect(execute).toHaveBeenCalledOnce();
});

test("an acknowledged mutation remains applied when authorization clears before presentation", async () => {
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const api = createLinearApi(async () => {
    await ready;
    return {
      workspace: "example",
      operationType: "mutation",
      status: 200,
      ok: true,
      effect: "applied",
      outcome: "success",
      data: { fixture: 1 },
    };
  });
  const pending = api.submit(
    "linear://example/api/graphql",
    '{"query":"mutation { fixture }"}',
    ".",
  );
  api.clear();
  finish();
  await expect(pending).rejects.toMatchObject({
    code: "LINEAR_OPERATION_CONNECTION_CHANGED",
    effect: "applied",
  });
});

test("contradictory success metadata cannot hide GraphQL failures", async () => {
  const execute = vi.fn(async () => ({
    workspace: "example",
    operationType: "mutation",
    status: 200,
    effect: "applied",
    ok: true,
    outcome: "success",
    errors: [{ message: "Fixture failure" }],
  }));
  const api = createLinearApi(execute);
  const result = await api.submit(
    "linear://example/api/graphql",
    '{"query":"mutation { fixture }"}',
    ".",
  );
  expect(result.data).toMatchObject({
    ok: false,
    effect: "unknown",
    error: "LINEAR_GRAPHQL_INVALID_RECEIPT",
  });
  expect(execute).toHaveBeenCalledOnce();
});

test("Write receipts keep response bodies lazy instead of duplicating them into session metadata", async () => {
  const marker = "Retained body fixture";
  const api = createLinearApi(async () => ({
    workspace: "example",
    operationType: "query",
    status: 200,
    effect: "not-applied",
    ok: true,
    outcome: "success",
    data: { marker },
  }));
  const result = await api.submit("linear://example/api/graphql", '{"query":"{ fixture }"}', ".");
  expect(JSON.stringify(result.data)).not.toContain(marker);
  expect(jsonRecord(await api.read(result.source, ".")).data).toEqual({ marker });
});

test.each([
  { query: "{ viewer { id } }", endpoint: "https://untrusted.invalid/graphql" },
  { query: "{ viewer { id } }", headers: { authorization: "Caller fixture" } },
  { query: "{ viewer { id } }", token: "Caller fixture" },
  { query: "{ viewer { id } }", variables: [] },
  { query: "{ viewer { id } }", operationName: "Invalid name" },
  { query: " " },
])("invalid raw request fields refuse before dispatch: %j", async (input) => {
  const execute = vi.fn(async () => ({}));
  await expect(
    createLinearApi(execute).submit("linear://example/api/graphql", JSON.stringify(input), "."),
  ).rejects.toMatchObject({ effect: "not-applied" });
  expect(execute).not.toHaveBeenCalled();
});

test("partial mutation data and unknown effects remain readable without replay", async () => {
  const errors = [{ message: "Fixture branch failure", path: ["fixture"] }];
  const execute = vi.fn(async () => ({
    workspace: "example",
    operationType: "mutation",
    status: 200,
    effect: "unknown",
    ok: false,
    outcome: "partial",
    data: { savedFixture: "fixture-1" },
    errors,
  }));
  const api = createLinearApi(execute);
  const result = await api.submit(
    "linear://example/api/graphql",
    '{"query":"mutation { fixture }"}',
    ".",
  );
  expect(result.data).toMatchObject({
    ok: false,
    effect: "unknown",
    outcome: "partial",
    errorCount: 1,
  });
  expect(result.data).not.toHaveProperty("errors");
  expect(jsonRecord(await api.read(result.source, "."))).toMatchObject({
    data: { savedFixture: "fixture-1" },
    errors,
    effect: "unknown",
  });
  expect(execute).toHaveBeenCalledOnce();
});

test("response retention is bounded and clearing removes prior observations", async () => {
  const api = createLinearApi(
    async () => ({
      workspace: "example",
      operationType: "query",
      status: 200,
      effect: "not-applied",
      ok: true,
      outcome: "success",
      data: { fixture: 1 },
    }),
    { maximumResults: 1 },
  );
  const first = await api.submit("linear://example/api/graphql", '{"query":"{ fixture }"}', ".");
  const second = await api.submit("linear://example/api/graphql", '{"query":"{ fixture }"}', ".");
  await expect(api.read(first.source, ".")).rejects.toMatchObject({
    code: "LINEAR_GRAPHQL_RESULT_UNAVAILABLE",
  });
  expect(jsonRecord(await api.read(second.source, ".")).data).toEqual({ fixture: 1 });
  await expect(api.read(second.source, "/different-fixture-root")).rejects.toMatchObject({
    code: "LINEAR_GRAPHQL_RESULT_UNAVAILABLE",
  });
  api.clear();
  await expect(api.read(second.source, ".")).rejects.toMatchObject({
    code: "LINEAR_GRAPHQL_RESULT_UNAVAILABLE",
  });
});

test("raw action ownership does not widen to credentials, other hosts or response resources", () => {
  const api = createLinearApi(async () => ({}));
  expect(api.ownsAction("linear://example/api/graphql")).toBe(true);
  for (const source of [
    "https://untrusted.invalid/graphql",
    "linear://user:fixture@example/api/graphql",
    "linear://example/api/graphql?endpoint=other",
    "linear://example/api/graphql#fields",
    "linear://example/api/results/20000000-0000-4000-8000-000000000002",
  ])
    expect(api.ownsAction(source)).toBe(false);
});

test("a raw response is retained immutably at a workspace-bound result resource", async () => {
  const response = {
    workspace: "example",
    operationType: "query",
    status: 200,
    effect: "not-applied",
    ok: true,
    outcome: "success",
    data: { fixture: "Original" },
  };
  const execute = vi.fn(async () => response);
  const api = createLinearApi(execute);
  const request = {
    query: "query Fixture($id: String!) { fixture(id: $id) }",
    variables: { id: "fixture-1" },
    operationName: "Fixture",
  };
  const result = await api.submit("linear://example/api/graphql", JSON.stringify(request), ".");
  expect(execute).toHaveBeenCalledExactlyOnceWith("example", request, ".", undefined);
  expect(result.source).toMatch(/^linear:\/\/example\/api\/results\/[0-9a-f-]{36}$/u);
  expect(result.data).toMatchObject({ ok: true, effect: "not-applied" });
  response.data.fixture = "Changed outside the store";
  expect(jsonRecord(await api.read(result.source, ".")).data).toEqual({ fixture: "Original" });
  await expect(
    api.read(result.source.replace("//example/", "//other/"), "."),
  ).rejects.toMatchObject({ effect: "not-applied" });
});

test("clearing authorization state cannot republish an in-flight response", async () => {
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const api = createLinearApi(async () => {
    await ready;
    return {
      workspace: "example",
      operationType: "query",
      status: 200,
      effect: "not-applied",
      ok: true,
      outcome: "success",
      data: { privateFixture: "Before switch" },
    };
  });
  const pending = api.submit("linear://example/api/graphql", '{"query":"{ viewer { id } }"}', ".");
  api.clear();
  finish();
  await expect(pending).rejects.toMatchObject({
    code: "LINEAR_OPERATION_CONNECTION_CHANGED",
    effect: "not-applied",
  });
});
test("raw GraphQL discovery advertises the bounded request contract without authorization or dispatch", async () => {
  const execute = vi.fn(async () => ({ workspace: "example" }));
  const source = "linear://example/api/graphql";
  const schema = jsonRecord(await createLinearApi(execute).read(source, "."));
  expect(schema).toMatchObject({
    source,
    tool: "write",
    mode: "YOLO",
    input: {
      required: ["query"],
      additionalProperties: false,
    },
  });
  expect(schema).toHaveProperty(["input", "properties", "variables"]);
  expect(schema).toHaveProperty(["input", "properties", "operationName"]);
  for (const key of ["endpoint", "headers", "authorization", "token"])
    expect(schema).not.toHaveProperty(["input", "properties", key]);
  expect(execute).not.toHaveBeenCalled();
});
