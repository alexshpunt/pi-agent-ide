import test from "node:test";
import assert from "node:assert/strict";
import { LinearGraphqlClient } from "#axi/graphql.ts";
import { fixtureGraphqlRequest, type FixtureGraphqlRequest } from "./fixtures/graphql-request.ts";
import { childrenCommand } from "#axi/commands/children.ts";
import type { Runtime } from "#axi/types.ts";
import { unexpectedSearch } from "./fixtures/native-search.ts";
const parentId = "11111111-1111-4111-8111-111111111111";
const child = {
  id: "22222222-2222-4222-8222-222222222222",
  identifier: "ENG-13",
  title: "Child",
  url: "https://linear.app/example/issue/ENG-13/child",
  parent: { id: parentId },
};
function client(
  nodes: unknown[],
  pageInfo = { hasNextPage: false, endCursor: null as string | null },
  workspace = "example",
) {
  const requests: FixtureGraphqlRequest[] = [];
  const value = new LinearGraphqlClient({
    tokenProvider: { getToken: async () => "fixture", clearCache: async () => {} },
    fetchImpl: async (_url, input) => {
      requests.push(fixtureGraphqlRequest(input));
      return new Response(
        JSON.stringify({
          data: {
            organization: { urlKey: workspace },
            parent: { id: parentId, url: "https://linear.app/example/issue/ENG-12/parent" },
            children: { nodes, pageInfo },
          },
        }),
      );
    },
  });
  return { value, requests };
}
void test("child collection uses parent filtering without inventing a search term and preserves cursor", async () => {
  const f = client([child], { hasNextPage: true, endCursor: "next/page" });
  const page = await f.value.listChildren({
    workspace: "example",
    parentId,
    limit: 2,
    cursor: "previous",
  });
  assert.equal(page.cursor, "next/page");
  assert.deepEqual(page.items, [
    { id: "ENG-13", uuid: child.id, title: "Child", url: child.url, parentId },
  ]);
  assert.match(f.requests[0].query, /children: issues\(/u);
  assert.deepEqual(f.requests[0].variables, {
    first: 2,
    after: "previous",
    parentId,
    filter: { parent: { id: { eq: parentId } } },
  });
});
void test("child collection rejects an unrelated parent or workspace and missing pagination", async () => {
  for (const f of [
    client([{ ...child, parent: { id: child.id } }]),
    client([child], undefined, "other"),
    client([], { hasNextPage: true, endCursor: null }),
  ])
    await assert.rejects(
      () => f.value.listChildren({ workspace: "example", parentId }),
      /LINEAR_(IDENTITY_MISMATCH|INVALID_RESPONSE)/u,
    );
});
void test("invalid child identity refuses before native authorization", async () => {
  const f = client([]);
  await assert.rejects(
    () => f.value.listChildren({ workspace: "example", parentId: "ENG-12" }),
    /LINEAR_INVALID_QUERY/u,
  );
  assert.equal(f.requests.length, 0);
});
void test("CLI child collection is explicit workspace/parent scoped and has no repo defaults", async () => {
  let seen: unknown;
  const runtime: Runtime = {
    cwd: process.cwd(),
    env: {},
    stdout: process.stdout,
    mcpUrl: "https://example.org",
    client: {
      listTools: async () => assert.fail("Children must not discover MCP tools"),
      callTool: async () => assert.fail("Children must not call MCP tools"),
    },
    searchClient: {
      searchObjects: unexpectedSearch,
      listChildren: async (input) => {
        seen = input;
        return { workspace: "example", parentId, items: [], hasMore: false };
      },
    },
  };
  const output = await childrenCommand(
    ["--workspace", "example", "--parent-id", parentId, "--limit", "2", "--cursor", "previous"],
    runtime,
  );
  assert.match(output, /children:/u);
  assert.deepEqual(seen, { workspace: "example", parentId, limit: 2, cursor: "previous" });
  await assert.rejects(
    () =>
      childrenCommand(["--workspace", "example", "--parent-id", parentId, "--query", "*"], runtime),
    /unsupported|requires/u,
  );
});
