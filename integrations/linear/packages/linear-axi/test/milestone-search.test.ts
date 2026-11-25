import test from "node:test";
import assert from "node:assert/strict";
import { nativeSearchPage, nativeSearchQuery } from "#axi/lib/native-search.ts";

const projectId = "10000000-0000-4000-8000-000000000001";
const milestoneId = "20000000-0000-4000-8000-000000000002";
const input = {
  kind: "issues" as const,
  term: "release",
  workspace: "example",
  limit: 2,
  projectId,
  milestoneId,
};
const issue = (number: number, state: string, milestone: string | null = milestoneId) => ({
  id: `uuid-${number}`,
  identifier: `ENG-${number}`,
  title: `Release ${number}`,
  url: `https://linear.app/example/issue/ENG-${number}/release`,
  project: { id: projectId },
  projectMilestone: milestone ? { id: milestone } : null,
  state: { type: state },
});
const page = (
  nodes: ReturnType<typeof issue>[],
  hasMore = false,
  cursor: string | null = null,
) => ({
  organization: { urlKey: "example" },
  results: { nodes, pageInfo: { hasNextPage: hasMore, endCursor: cursor }, totalCount: 4 },
});

void test("milestone search sends project and milestone constraints to the server on every window", () => {
  for (const cursor of [undefined, "empty-window", "last-window"]) {
    const query = nativeSearchQuery({ ...input, cursor });
    assert.deepEqual(query.variables.filter, {
      project: { id: { eq: projectId } },
      projectMilestone: { id: { eq: milestoneId } },
    });
    assert.equal(query.variables.term, "release");
    assert.equal(query.variables.after, cursor ?? null);
    assert.match(query.query, /filter: \$filter/);
    assert.match(query.query, /projectMilestone\s*\{\s*id\s*\}/);
  }
});

void test("milestone results preserve mixed statuses and reject other or unassigned milestones", () => {
  for (const state of ["backlog", "started", "completed", "canceled"]) {
    const result = nativeSearchPage(page([issue(12, state)]), input);
    assert.deepEqual(
      result.items.map(({ id }) => id),
      ["ENG-12"],
    );
    assert.equal(result.milestoneId, milestoneId);
  }
  for (const other of [null, "30000000-0000-4000-8000-000000000003"])
    assert.throws(() => nativeSearchPage(page([issue(13, "started", other)]), input), {
      message: "LINEAR_IDENTITY_MISMATCH",
    });
});

void test("empty milestone windows retain verified progress and an empty final page terminates", () => {
  const data = {
    ...page([], true),
    candidates: {
      nodes: [{ id: "outside" }],
      pageInfo: { hasNextPage: true, endCursor: "next" },
      totalCount: 4,
    },
  };
  const result = nativeSearchPage(data, input);
  assert.deepEqual(result.items, []);
  assert.equal(result.cursor, "next");
  assert.equal(result.milestoneId, milestoneId);
  const final = nativeSearchPage(page([]), { ...input, cursor: result.cursor });
  assert.deepEqual(final.items, []);
  assert.equal(final.hasMore, false);
  assert.equal(final.cursor, undefined);
  assert.equal(final.milestoneId, milestoneId);
});

void test("milestone constraints require issue search and canonical project and milestone UUIDs", () => {
  for (const patch of [
    { kind: "projects" as const },
    { kind: "documents" as const },
    { milestoneId: "" },
    { milestoneId: "Release" },
    { projectId: undefined },
    { projectId: "project" },
  ])
    assert.throws(() => nativeSearchQuery({ ...input, ...patch }), {
      message: "LINEAR_INVALID_QUERY",
    });
});
