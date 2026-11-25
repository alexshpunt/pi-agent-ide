/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { LinearGraphqlClient } from "#axi/graphql.ts";
import { fixtureGraphqlRequest, type FixtureGraphqlRequest } from "./fixtures/graphql-request.ts";

function searchClient(data: unknown, requests: FixtureGraphqlRequest[] = []) {
  return new LinearGraphqlClient({
    tokenProvider: { getToken: async () => "fixture", clearCache: async () => {} },
    fetchImpl: async (_url, init) => {
      requests.push(fixtureGraphqlRequest(init));
      return new Response(JSON.stringify({ data }), { status: 200 });
    },
  });
}

void test("native project search uses GraphQL full-text search and returns canonical page identities", async () => {
  const requests: FixtureGraphqlRequest[] = [];
  const client = searchClient(
    {
      organization: { urlKey: "example" },
      results: {
        nodes: [
          {
            id: "project-uuid",
            name: "Project",
            url: "https://linear.app/example/project/project-ab12cd34ef56",
            teams: { nodes: [{ id: "team-id" }] },
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "next" },
        totalCount: 3,
      },
    },
    requests,
  );
  const result = await client.searchObjects({
    kind: "projects",
    term: "body-only phrase",
    workspace: "example",
    limit: 10,
    cursor: "previous",
    includeComments: true,
  });
  assert.equal(result.hasMore, true);
  assert.equal(result.cursor, "next");
  assert.equal(result.workspace, "example");
  assert.deepEqual(result.items, [
    {
      id: "project-uuid",
      title: "Project",
      url: "https://linear.app/example/project/project-ab12cd34ef56",
    },
  ]);
  assert.match(requests[0].query, /results: searchProjects\(/);
  assert.deepEqual(requests[0].variables, {
    term: "body-only phrase",
    first: 10,
    after: "previous",
    includeComments: true,
    includeArchived: false,
  });
});

void test("native issue search uses hard filters, not the deprecated team ranking boost", async () => {
  const requests: FixtureGraphqlRequest[] = [];
  const client = searchClient(
    {
      organization: { urlKey: "example" },
      results: {
        nodes: [
          {
            id: "issue-uuid",
            identifier: "ENG-12",
            title: "Issue",
            url: "https://linear.app/example/issue/ENG-12/issue",
            team: { id: "team-id" },
            project: { id: "project-id" },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: 1,
      },
      candidates: {
        nodes: [{ id: "issue-uuid" }],
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: 1,
      },
    },
    requests,
  );
  const result = await client.searchObjects({
    kind: "issues",
    term: "word",
    workspace: "example",
    teamId: "team-id",
    projectId: "project-id",
  });
  assert.equal(result.items[0].id, "ENG-12");
  assert.deepEqual(requests[0].variables.filter, {
    team: { id: { eq: "team-id" } },
    project: { id: { eq: "project-id" } },
  });
  assert.equal(requests[0].variables.teamId, undefined);
});

void test("document scope removes outside records but keeps server continuation and incomplete coverage", async () => {
  const client = searchClient({
    organization: { urlKey: "example" },
    results: {
      nodes: [
        {
          id: "doc-outside",
          title: "Outside",
          url: "https://linear.app/example/document/outside-111111111111",
          project: { id: "outside" },
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: "next" },
      totalCount: 4,
    },
  });
  const result = await client.searchObjects({
    kind: "documents",
    term: "word",
    workspace: "example",
    projectId: "inside",
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.hasMore, true);
  assert.equal(result.cursor, "next");
  assert.equal(result.postFiltered, true);
});

void test("native search refuses workspace mismatch, malformed pages and missing continuation", async () => {
  const valid = {
    organization: { urlKey: "example" },
    results: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 },
  };
  await assert.rejects(
    () => searchClient(valid).searchObjects({ kind: "issues", term: "word", workspace: "other" }),
    /LINEAR_IDENTITY_MISMATCH/,
  );
  for (const results of [
    { nodes: [], pageInfo: { hasNextPage: true, endCursor: null }, totalCount: 1 },
    { nodes: [{}], pageInfo: { hasNextPage: false }, totalCount: 1 },
  ]) {
    await assert.rejects(
      () =>
        searchClient({ ...valid, results }).searchObjects({
          kind: "issues",
          term: "word",
          workspace: "example",
        }),
      /LINEAR_INVALID_RESPONSE/,
    );
  }
});

void test("native search refreshes once and sanitizes rate, permission and GraphQL failures", async () => {
  const input = { kind: "issues" as const, term: "word", workspace: "example" };
  let calls = 0;
  let cleared = 0;
  const client = new LinearGraphqlClient({
    tokenProvider: {
      getToken: async () => "fixture",
      clearCache: async () => {
        cleared++;
      },
    },
    fetchImpl: async () => {
      calls++;
      return new Response("private body", { status: 401 });
    },
  });
  await assert.rejects(() => client.searchObjects(input), /^Error: LINEAR_GRAPHQL_AUTH_REQUIRED$/);
  assert.equal(calls, 2);
  assert.equal(cleared, 1);
  for (const [status, code] of [
    [429, "LINEAR_RATE_LIMITED"],
    [403, "LINEAR_PERMISSION_DENIED"],
    [500, "LINEAR_GRAPHQL_FAILED"],
  ] as const) {
    const failed = new LinearGraphqlClient({
      tokenProvider: { getToken: async () => "fixture", clearCache: async () => {} },
      fetchImpl: async () => new Response("private body", { status }),
    });
    await assert.rejects(() => failed.searchObjects(input), new RegExp(`^Error: ${code}$`));
  }
  const failed = new LinearGraphqlClient({
    tokenProvider: { getToken: async () => "fixture", clearCache: async () => {} },
    fetchImpl: async () =>
      new Response(JSON.stringify({ errors: [{ message: "private content" }] })),
  });
  await assert.rejects(() => failed.searchObjects(input), /^Error: LINEAR_GRAPHQL_FAILED$/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => client.searchObjects({ ...input, signal: controller.signal }), {
    name: "AbortError",
  });
});

const parentId = "01234567-89ab-4cde-8fab-0123456789ab";

void test("direct child native search combines parent, team and project filters and preserves the cursor", async () => {
  const requests: FixtureGraphqlRequest[] = [];
  const client = searchClient(
    {
      organization: { urlKey: "example" },
      results: {
        nodes: [
          {
            id: "child-uuid",
            identifier: "ENG-13",
            title: "Child",
            url: "https://linear.app/example/issue/ENG-13/child",
            parent: { id: parentId },
            team: { id: "team-id" },
            project: { id: "project-id" },
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "child-next" },
        totalCount: 2,
      },
      candidates: {
        nodes: [{ id: "child-uuid" }],
        pageInfo: { hasNextPage: true, endCursor: "candidate-next" },
        totalCount: 2,
      },
    },
    requests,
  );
  const page = await client.searchObjects({
    kind: "issues",
    term: "comment word",
    workspace: "example",
    parentId,
    teamId: "team-id",
    projectId: "project-id",
    cursor: "previous",
    limit: 1,
    includeComments: true,
  });
  assert.deepEqual(requests[0].variables.filter, {
    parent: { id: { eq: parentId } },
    team: { id: { eq: "team-id" } },
    project: { id: { eq: "project-id" } },
  });
  assert.match(requests[0].query, /parent \{ id \}/);
  assert.match(requests[0].query, /filter: \$filter/);
  assert.equal(requests[0].variables.after, "previous");
  assert.equal(requests[0].variables.includeComments, true);
  assert.equal(page.cursor, "candidate-next");
  assert.equal(page.totalCount, 2);
  assert.equal(page.postFiltered, true);
  assert.equal(page.items[0].id, "ENG-13");
});

void test("direct child search rejects outside parents instead of silently widening its scope", async () => {
  for (const parent of [null, { id: "other-parent" }, { id: "grandchild-parent" }]) {
    const client = searchClient({
      organization: { urlKey: "example" },
      results: {
        nodes: [
          {
            id: "child-uuid",
            identifier: "ENG-13",
            title: "Child",
            url: "https://linear.app/example/issue/ENG-13/child",
            parent,
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: 1,
      },
    });
    await assert.rejects(
      () => client.searchObjects({ kind: "issues", term: "word", workspace: "example", parentId }),
      /LINEAR_IDENTITY_MISMATCH/,
    );
  }
});

void test("parent-scoped native empty pages retain continuation and server totals", async () => {
  const client = searchClient({
    organization: { urlKey: "example" },
    results: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "child-next" }, totalCount: 3 },
    candidates: {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "child-next" },
      totalCount: 3,
    },
  });
  const page = await client.searchObjects({
    kind: "issues",
    term: "word",
    workspace: "example",
    parentId,
  });
  assert.deepEqual(page.items, []);
  assert.equal(page.cursor, "child-next");
  assert.equal(page.totalCount, 3);
  assert.equal(page.hasMore, true);
});

void test("native filtered pages continue using a verified candidate window when Linear omits the filtered cursor", async () => {
  const requests: FixtureGraphqlRequest[] = [];
  const client = searchClient(
    {
      organization: { urlKey: "example" },
      results: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null }, totalCount: 10 },
      candidates: {
        nodes: [{ id: "outside-one" }, { id: "outside-two" }],
        pageInfo: { hasNextPage: true, endCursor: "candidate-next" },
        totalCount: 10,
      },
    },
    requests,
  );
  const page = await client.searchObjects({
    kind: "issues",
    term: "word",
    workspace: "example",
    parentId,
    limit: 2,
  });
  assert.deepEqual(page.items, []);
  assert.equal(page.cursor, "candidate-next");
  assert.equal(page.hasMore, true);
  assert.equal(page.totalCount, 10);
  assert.equal(page.postFiltered, true);
  assert.match(requests[0].query, /candidates: searchIssues\(/);
});

void test("a candidate continuation cannot silently skip filtered matches outside its verified page", async () => {
  const client = searchClient({
    organization: { urlKey: "example" },
    results: {
      nodes: [
        {
          id: "child-uuid",
          identifier: "ENG-13",
          title: "Child",
          url: "https://linear.app/example/issue/ENG-13/child",
          parent: { id: parentId },
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: "child-next" },
      totalCount: 10,
    },
    candidates: {
      nodes: [{ id: "different-window" }],
      pageInfo: { hasNextPage: true, endCursor: "candidate-next" },
      totalCount: 10,
    },
  });
  await assert.rejects(
    () => client.searchObjects({ kind: "issues", term: "word", workspace: "example", parentId }),
    /LINEAR_INVALID_RESPONSE/,
  );
});
void test("parent scope is issues-only and requires a verified UUID before authorization", async () => {
  const requests: FixtureGraphqlRequest[] = [];
  const client = searchClient({}, requests);
  for (const kind of ["projects", "documents"] as const) {
    await assert.rejects(
      () => client.searchObjects({ kind, term: "word", workspace: "example", parentId }),
      /LINEAR_INVALID_QUERY/,
    );
  }
  for (const invalid of ["", "ENG-12", "not-an-id", "01234567-89ab-4cde-8fab-0123456789ab\n"]) {
    await assert.rejects(
      () =>
        client.searchObjects({
          kind: "issues",
          term: "word",
          workspace: "example",
          parentId: invalid,
        }),
      /LINEAR_INVALID_QUERY/,
    );
  }
  assert.equal(requests.length, 0);
});
