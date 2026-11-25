import test from "node:test";
import assert from "node:assert/strict";
import { run } from "#axi/cli.ts";
import type { Runtime } from "#axi/types.ts";

function runtime(
  responses: Record<string, unknown>,
  calls: Array<[string, unknown]> = [],
): Runtime {
  return {
    cwd: process.cwd(),
    env: {},
    stdout: process.stdout,
    mcpUrl: "https://example.org",
    client: {
      listTools: async () => Object.keys(responses).map((name) => ({ name })),
      callTool: async (name, args) => {
        calls.push([name, args]);
        return { structuredContent: responses[name] };
      },
    },
  };
}
void test("native search CLI forwards explicit scope, pagination and comment coverage without MCP calls", async () => {
  const r = runtime({});
  let input;
  r.searchClient = {
    searchObjects: async (value) => {
      input = value;
      return { ...value, items: [], totalCount: 0, hasMore: false, postFiltered: false };
    },
  };
  const result = await run(
    [
      "search",
      "issues",
      "--query",
      "body text",
      "--workspace",
      "example",
      "--team-id",
      "team",
      "--cursor",
      "next",
      "--limit",
      "3",
      "--include-comments",
    ],
    r,
  );
  assert.equal(input.teamId, "team");
  assert.equal(input.limit, 3);
  assert.equal(input.includeComments, true);
  assert.match(result, /hasMore: false/);
  await assert.rejects(
    () =>
      run(
        ["search", "issues", "--query", "word", "--workspace", "example", "--unsafe", "value"],
        r,
      ),
    /unsupported search flag/,
  );
});
void test("native child search forwards the verified parent UUID and refuses other kinds before dispatch", async () => {
  const parentId = "01234567-89ab-4cde-8fab-0123456789ab";
  const r = runtime({});
  const inputs: unknown[] = [];
  r.searchClient = {
    searchObjects: async (input) => {
      inputs.push(input);
      return {
        kind: input.kind,
        term: input.term,
        workspace: input.workspace,
        items: [],
        totalCount: 0,
        hasMore: false,
        postFiltered: false,
      };
    },
  };
  await run(
    [
      "search",
      "issues",
      "--query",
      "word",
      "--workspace",
      "example",
      "--parent-id",
      parentId,
      "--team-id",
      "team",
      "--project-id",
      "project",
      "--cursor",
      "next",
    ],
    r,
  );
  assert.equal((inputs[0] as { parentId: string }).parentId, parentId);
  assert.equal((inputs[0] as { cursor: string }).cursor, "next");
  for (const kind of ["projects", "documents"])
    await assert.rejects(
      () =>
        run(
          ["search", kind, "--query", "word", "--workspace", "example", "--parent-id", parentId],
          r,
        ),
      /parent scope/,
    );
  for (const invalid of ["ENG-12", "not-an-id"])
    await assert.rejects(
      () =>
        run(
          ["search", "issues", "--query", "word", "--workspace", "example", "--parent-id", invalid],
          r,
        ),
      /parent scope/,
    );
  assert.equal(inputs.length, 1);
});
void test("directory search verifies workspace and forwards only the real API lookup fields", async () => {
  const calls: Array<[string, unknown]> = [];
  const r = runtime(
    {
      get_workspace: { url: "https://linear.app/example" },
      list_teams: { teams: [{ id: "t1", name: "Engineering" }], hasNextPage: true, cursor: "next" },
    },
    calls,
  );
  const result = await run(
    ["resources", "list", "teams", "--query", "Eng", "--workspace", "example", "--limit", "3"],
    r,
  );
  assert.deepEqual(calls, [
    ["get_workspace", {}],
    ["list_teams", { limit: 3, query: "Eng" }],
  ]);
  assert.match(result, /cursor: next/);
  await assert.rejects(
    () => run(["resources", "list", "teams", "--workspace", "other"], r),
    /LINEAR_IDENTITY_MISMATCH/,
  );
  assert.equal(calls.length, 3);
});
void test("parent directories require a scope and mark bounded coverage without inventing full-text search", async () => {
  const r = runtime({
    get_workspace: { url: "https://linear.app/example" },
    list_cycles: [
      { id: "c1", name: "Sprint one" },
      { id: "c2", name: "Sprint two" },
    ],
  });
  await assert.rejects(
    () => run(["resources", "list", "cycles", "--workspace", "example"], r),
    /LINEAR_PARENT_SCOPE_REQUIRED/,
  );
  const result = await run(
    [
      "resources",
      "list",
      "cycles",
      "--workspace",
      "example",
      "--scope",
      "t1",
      "--query",
      "Sprint",
      "--limit",
      "1",
    ],
    r,
  );
  assert.match(result, /hasMore: true/);
  assert.match(result, /returned parent list only/);
  await assert.rejects(
    () =>
      run(
        [
          "resources",
          "view",
          "cycles",
          "missing",
          "--workspace",
          "example",
          "--scope",
          "t1",
          "--limit",
          "1",
        ],
        r,
      ),
    /LINEAR_LOOKUP_INCOMPLETE/,
  );
});
void test("directory empty release/view payloads are valid and MCP failures never expose private bodies", async () => {
  const r = runtime({
    get_workspace: { url: "https://linear.app/example" },
    list_releases: { releases: [], hasNextPage: false },
    list_custom_views: { customViews: [], hasNextPage: false },
  });
  for (const kind of ["releases", "views"])
    assert.match(
      await run(["resources", "list", kind, "--workspace", "example", "--query", "word"], r),
      /items: \[\]/,
    );
  r.client.callTool = async () => {
    throw new Error("private bearer-value server body");
  };
  await assert.rejects(
    () => run(["resources", "list", "teams", "--workspace", "example"], r),
    /^Error: LINEAR_RESOURCE_FAILED$/,
  );
});

void test("resource reads reject unsupported types and mismatched IDs", async () => {
  const r = runtime({
    get_workspace: { url: "https://linear.app/example" },
    get_user: { id: "other", name: "Other" },
  });
  await assert.rejects(
    () => run(["resources", "view", "users", "u1", "--workspace", "example"], r),
    /LINEAR_IDENTITY_MISMATCH/,
  );
  await assert.rejects(
    () => run(["resources", "view", "delete", "u1", "--workspace", "example"], r),
    /LINEAR_RESOURCE_UNSUPPORTED/,
  );
});
