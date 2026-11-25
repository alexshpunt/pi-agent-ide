/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { parse, visit, type FieldNode } from "graphql";
import { decode } from "@toon-format/toon-v4";
import { run } from "#axi/cli.ts";
import { LinearGraphqlClient } from "#axi/graphql.ts";
import { fixtureGraphqlRequest } from "./fixtures/graphql-request.ts";
import type { Runtime } from "#axi/types.ts";

const projects = [
  {
    id: "project-one",
    name: "First",
    teams: { nodes: [{ id: "other-team" }, { id: "target-team" }] },
  },
  { id: "project-two", name: "Second", teams: { nodes: [{ id: "other-team" }] } },
];
function fixture() {
  const requests: Array<{ teams: FieldNode[]; variables: Record<string, unknown> }> = [];
  const searchClient = new LinearGraphqlClient({
    tokenProvider: { getToken: async () => "fixture", clearCache: async () => {} },
    fetchImpl: async (_url, init) => {
      const request = fixtureGraphqlRequest(init);
      const teams: FieldNode[] = [];
      visit(parse(request.query), {
        Field(node) {
          if (node.name.value === "teams") teams.push(node);
        },
      });
      requests.push({ teams, variables: request.variables });
      return new Response(
        JSON.stringify({
          data: {
            organization: { urlKey: "example" },
            results: {
              nodes: projects.map(({ id, name, teams: memberships }) => ({
                id,
                name,
                url: `https://linear.app/example/project/${id}`,
                ...(teams.length ? { teams: memberships } : {}),
              })),
              pageInfo: { hasNextPage: true, endCursor: "server-next" },
              totalCount: 3,
            },
          },
        }),
      );
    },
  });
  const runtime: Runtime = {
    cwd: process.cwd(),
    env: {},
    stdout: process.stdout,
    mcpUrl: "https://example.org",
    searchClient,
    client: {
      listTools: async () => assert.fail("Native search must not discover MCP tools"),
      callTool: async () => assert.fail("Native search must not invoke MCP tools"),
    },
  };
  const search = async (scope: string[]) =>
    decode(
      await run(
        [
          "search",
          "projects",
          "--query",
          "scope",
          "--workspace",
          "example",
          "--limit",
          "3",
          "--cursor",
          "server-previous",
          ...scope,
        ],
        runtime,
      ),
    ) as {
      search: {
        items: Array<{ id: string }>;
        cursor: string;
        totalCount: number;
        hasMore: boolean;
      };
    };
  return { search, requests };
}

void test("global and project-only searches omit unused project team connections", async () => {
  for (const scope of [[], ["--project-id", "project-one"]]) {
    const f = fixture();
    const result = (await f.search(scope)).search;
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].teams.length, 0);
    assert.equal(f.requests[0].variables.first, 3);
    assert.equal(f.requests[0].variables.after, "server-previous");
    assert.deepEqual(
      result.items.map(({ id }) => id),
      scope.length ? ["project-one"] : ["project-one", "project-two"],
    );
    assert.equal(result.cursor, "server-next");
    assert.equal(result.totalCount, 3);
    assert.equal(result.hasMore, true);
  }
});

void test("team-scoped project searches retain memberships beyond the first team and preserve pagination", async () => {
  const f = fixture();
  const result = (await f.search(["--team-id", "target-team"])).search;
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].teams.length, 1);
  assert.deepEqual(f.requests[0].teams[0].arguments ?? [], []);
  assert.deepEqual(
    result.items.map(({ id }) => id),
    ["project-one"],
  );
  assert.equal(result.cursor, "server-next");
  assert.equal(result.totalCount, 3);
  assert.equal(result.hasMore, true);
});
