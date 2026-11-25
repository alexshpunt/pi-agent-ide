import test from "node:test";
import assert from "node:assert/strict";
import { LinearGraphqlClient } from "#axi/graphql.ts";
import { fixtureGraphqlRequest, type FixtureGraphqlRequest } from "./fixtures/graphql-request.ts";

const input = { kind: "issues" as const, term: "scope", workspace: "example", limit: 2 };
const issue = {
  id: "issue-one",
  identifier: "ENG-12",
  title: "Scoped issue",
  url: "https://linear.app/example/issue/ENG-12/scoped-issue",
  project: { id: "project-id" },
  team: { id: "team-id" },
};
function page(
  nodes: (typeof issue)[],
  candidates: { id: string }[],
  hasNextPage = true,
  endCursor: string | null = "candidate-next",
) {
  return {
    organization: { urlKey: "example" },
    results: {
      nodes,
      pageInfo: { hasNextPage, endCursor: nodes.at(-1)?.id ?? null },
      totalCount: 6,
    },
    candidates: {
      nodes: candidates,
      pageInfo: { hasNextPage, endCursor },
      totalCount: 6,
    },
  };
}
type IssuePageFixture = Omit<ReturnType<typeof page>, "candidates"> &
  Partial<Pick<ReturnType<typeof page>, "candidates">>;

function client(
  response: IssuePageFixture | ((request: FixtureGraphqlRequest) => IssuePageFixture),
  requests: FixtureGraphqlRequest[] = [],
) {
  return new LinearGraphqlClient({
    tokenProvider: { getToken: async () => "fixture", clearCache: async () => {} },
    fetchImpl: async (_url, init) => {
      const request = fixtureGraphqlRequest(init);
      requests.push(request);
      const data = typeof response === "function" ? response(request) : response;
      return new Response(JSON.stringify({ data }));
    },
  });
}

for (const scope of [
  { projectId: "project-id" },
  { teamId: "team-id" },
  { projectId: "project-id", teamId: "team-id" },
]) {
  void test(`empty issue windows keep a verified continuation for ${Object.keys(scope).join(" and ")}`, async () => {
    const requests: FixtureGraphqlRequest[] = [];
    const result = await client(
      page([], [{ id: "outside-one" }, { id: "outside-two" }]),
      requests,
    ).searchObjects({ ...input, ...scope, cursor: "previous" });
    assert.deepEqual(result.items, []);
    assert.equal(result.hasMore, true);
    assert.equal(result.cursor, "candidate-next");
    assert.equal(result.totalCount, 6);
    assert.equal(result.postFiltered, true);
    assert.match(requests[0].query, /candidates: searchIssues\(/);
    assert.match(requests[0].query, /filter: \$filter/);
    assert.deepEqual(requests[0].variables.filter, {
      ...(scope.projectId ? { project: { id: { eq: scope.projectId } } } : {}),
      ...(scope.teamId ? { team: { id: { eq: scope.teamId } } } : {}),
    });
    assert.equal(requests[0].variables.after, "previous");
  });
}

void test("project pagination crosses an empty window without skipping later matches", async () => {
  const later = {
    ...issue,
    id: "issue-two",
    identifier: "ENG-13",
    url: "https://linear.app/example/issue/ENG-13/later-match",
  };
  const requests: FixtureGraphqlRequest[] = [];
  const search = client(({ variables }) => {
    switch (variables.after) {
      case null: {
        return page([issue], [{ id: "outside-one" }, { id: "outside-two" }], true, "first-end");
      }
      case "issue-one": {
        return page([], [{ id: "outside-two" }, { id: "outside-three" }], true, "middle-end");
      }
      case "middle-end": {
        return page([later], [{ id: later.id }], false, later.id);
      }
      default: {
        assert.fail(
          "Search did not preserve the matching cursor or the verified empty-window cursor",
        );
      }
    }
  }, requests);
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let window = 0; window < 3; window++) {
    const result = await search.searchObjects({ ...input, projectId: "project-id", cursor });
    ids.push(...result.items.map(({ id }) => id));
    if (!result.hasMore) {
      assert.equal(window, 2);
      assert.equal(result.cursor, undefined);
      break;
    }
    cursor = result.cursor;
  }
  assert.deepEqual(ids, ["ENG-12", "ENG-13"]);
  assert.deepEqual(
    requests.map(({ variables }) => variables.after),
    [null, "issue-one", "middle-end"],
  );
});

void test("a candidate window cannot replace a broken cursor on a non-empty scoped page", async () => {
  const valid = page([issue], [{ id: "outside-one" }]);
  for (const cursor of [null, "", "previous", "bad\ncursor"]) {
    await assert.rejects(
      () =>
        client({
          ...valid,
          results: { ...valid.results, pageInfo: { hasNextPage: true, endCursor: cursor } },
        }).searchObjects({ ...input, projectId: "project-id", cursor: "previous" }),
      /LINEAR_INVALID_RESPONSE/,
    );
  }
});
void test("an empty final project page is a successful end, not a missing cursor", async () => {
  const result = await client(page([], [], false, null)).searchObjects({
    ...input,
    projectId: "project-id",
    cursor: "previous",
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.hasMore, false);
  assert.equal(result.cursor, undefined);
});

void test("empty project candidate windows reject malformed progress and foreign results", async () => {
  const valid = page([], [{ id: "outside-one" }]);
  for (const candidates of [
    undefined,
    { ...valid.candidates, nodes: [{ id: "" }] },
    { ...valid.candidates, nodes: [{ id: issue.id }, { id: issue.id }] },
    { ...valid.candidates, totalCount: 7 },
    { ...valid.candidates, pageInfo: { hasNextPage: false, endCursor: null } },
    { ...valid.candidates, pageInfo: { hasNextPage: true, endCursor: null } },
    { ...valid.candidates, pageInfo: { hasNextPage: true, endCursor: "previous" } },
  ]) {
    await assert.rejects(
      () =>
        client({ ...valid, candidates }).searchObjects({
          ...input,
          projectId: "project-id",
          cursor: "previous",
        }),
      /LINEAR_INVALID_RESPONSE/,
    );
  }
  await assert.rejects(
    () =>
      client(page([{ ...issue, project: { id: "outside" } }], [{ id: issue.id }])).searchObjects({
        ...input,
        projectId: "project-id",
      }),
    /LINEAR_IDENTITY_MISMATCH/,
  );
});
