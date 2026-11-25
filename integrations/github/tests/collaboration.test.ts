import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import { GithubCollaboration } from "#github/collaboration.ts";
import { parseGithubAddress } from "#github/address.ts";
import { GithubApiError } from "#github/client.ts";

const repo = { id: "R_repo", nameWithOwner: "owner/repo" };
const discussion = (overrides: Record<string, unknown> = {}) => ({
  __typename: "Discussion",
  id: "D_one",
  number: 3,
  title: "Fixture",
  body: "Original body",
  updatedAt: "2026-10-10T20:00:00Z",
  url: "https://github.com/owner/repo/discussions/3",
  repository: repo,
  category: { id: "C_one" },
  ...overrides,
});
const comment = (overrides: Record<string, unknown> = {}) => ({
  __typename: "DiscussionComment",
  id: "DC_one",
  body: "Comment body",
  updatedAt: "2026-10-10T20:00:00Z",
  url: "https://github.com/owner/repo/discussions/3#discussioncomment-42",
  discussion: discussion(),
  ...overrides,
});
const thread = (overrides: Record<string, unknown> = {}) => ({
  __typename: "PullRequestReviewThread",
  id: "PRRT_one",
  isResolved: false,
  isOutdated: false,
  path: "src/a.ts",
  line: 12,
  pullRequest: { number: 7 },
  repository: repo,
  viewerCanResolve: true,
  viewerCanUnresolve: true,
  ...overrides,
});
const pageInfo = { hasNextPage: false, endCursor: null };
function checkedAddress(source: string) {
  const value = parseGithubAddress(source);
  assert.ok(value);
  return value;
}
const address = (suffix: string) => checkedAddress("github://owner/repo/" + suffix);
function adapter(run: (query: string, variables: Record<string, unknown>) => unknown) {
  const graphql = vi.fn(async (query: string, variables: Record<string, unknown>) =>
    run(query, variables),
  );
  const client = { graphql };
  return { collaboration: new GithubCollaboration(async () => client), graphql };
}

test("GraphQL cards retain the actual author login and actor type", async () => {
  const { collaboration } = adapter(() => ({
    repository: {
      ...repo,
      discussion: discussion({ author: { login: "fixture-app", __typename: "Bot" } }),
    },
  }));
  const card = await collaboration.read(address("discussions/3"), "/tmp");
  expect(card.content).toContain("Author: fixture-app\n");
  expect(card.content).toContain("Author type: Bot");
});
test("reads a discussion body separately from fields and rejects selected native comment fragments", async () => {
  const { collaboration } = adapter(() => ({ repository: { ...repo, discussion: discussion() } }));
  expect(await collaboration.read(address("discussions/3#body"), "/tmp")).toMatchObject({
    content: "Original body",
    editable: true,
    field: "body",
  });
  const fields = await collaboration.read(address("discussions/3#fields"), "/tmp");
  expect(JSON.parse(fields.content)).toEqual({
    title: "Fixture",
    body: "Original body",
    categoryId: "C_one",
  });
  await expect(
    collaboration.read(
      checkedAddress("https://github.com/owner/repo/discussions/3#discussioncomment-42"),
      "/tmp",
    ),
  ).rejects.toMatchObject({ code: "GH_UNSUPPORTED_COMMENT_FRAGMENT", effect: "not-applied" });
});

test("verifies node type, node ID and repository for every addressed discussion comment", async () => {
  for (const value of [
    comment({ __typename: "IssueComment" }),
    comment({ id: "DC_other" }),
    comment({ discussion: discussion({ repository: { nameWithOwner: "other/repo" } }) }),
  ]) {
    const { collaboration } = adapter(() => ({ node: value }));
    await expect(
      collaboration.read(address("discussion-comments/DC_one#body"), "/tmp"),
    ).rejects.toMatchObject({ code: "GH_IDENTITY_MISMATCH", effect: "not-applied" });
  }
  const { collaboration } = adapter(() => ({ node: comment() }));
  expect(
    await collaboration.read(address("discussion-comments/DC_one#body"), "/tmp"),
  ).toMatchObject({ content: "Comment body", editable: true });
});

test("refuses a stale discussion snapshot before mutation", async () => {
  let body = "Original body";
  const { collaboration, graphql } = adapter(() => ({
    repository: { ...repo, discussion: discussion({ body }) },
  }));
  const target = address("discussions/3#body");
  const expected = await collaboration.read(target, "/tmp");
  body = "Another actor changed it";
  await expect(collaboration.save(target, expected, "Replacement", "/tmp")).rejects.toMatchObject({
    code: "GH_STALE_RESOURCE",
    effect: "not-applied",
  });
  expect(graphql.mock.calls.every(([query]) => !query.startsWith("mutation"))).toBe(true);
});

test("edits a discussion comment using its bound node and rereads the saved content", async () => {
  let body = "Comment body";
  const { collaboration, graphql } = adapter((query, variables) => {
    if (query.startsWith("mutation")) {
      expect(variables).toEqual({ input: { commentId: "DC_one", body: "New body" } });
      body = "New body";
      return { updateDiscussionComment: { comment: comment({ body }) } };
    }
    return { node: comment({ body }) };
  });
  const target = address("discussion-comments/DC_one#body");
  await collaboration.save(target, await collaboration.read(target, "/tmp"), "New body", "/tmp");
  expect(graphql.mock.calls.filter(([query]) => query.startsWith("mutation"))).toHaveLength(1);
  expect((await collaboration.read(target, "/tmp")).content).toBe("New body");
});

test("bounds list pages, reports completeness and returns an exact cursor link without fetching bodies", async () => {
  const { collaboration, graphql } = adapter((_query, variables) => {
    expect(variables).toMatchObject({ first: 2, after: null });
    return {
      repository: {
        ...repo,
        discussions: {
          nodes: [discussion()],
          pageInfo: { hasNextPage: true, endCursor: "next+/=" },
        },
      },
    };
  });
  const result = await collaboration.read(address("discussions?per_page=2"), "/tmp");
  expect(result.content).toContain("Coverage is incomplete");
  expect(result.content).toContain(
    "github://owner/repo/discussions?per_page=2&cursor=next%2B%2F%3D",
  );
  expect(result.content).not.toContain("Original body");
  expect(graphql).toHaveBeenCalledTimes(1);
  await expect(
    collaboration.read(address("discussions?per_page=51"), "/tmp"),
  ).rejects.toMatchObject({ code: "GH_INVALID_PAGE" });
});

test("rejects a foreign discussion category and identity override before creation", async () => {
  const { collaboration, graphql } = adapter(() => ({
    node: {
      __typename: "DiscussionCategory",
      id: "C_one",
      repository: { nameWithOwner: "other/repo" },
    },
  }));
  await expect(
    collaboration.perform(
      address("discussions/new"),
      JSON.stringify({ categoryId: "C_one", title: "Test", body: "Body" }),
      "/tmp",
    ),
  ).rejects.toMatchObject({ code: "GH_IDENTITY_MISMATCH", effect: "not-applied" });
  expect(graphql.mock.calls.every(([query]) => !query.startsWith("mutation"))).toBe(true);
  await expect(
    collaboration.perform(
      address("discussions/new"),
      JSON.stringify({
        repositoryId: "R_foreign",
        categoryId: "C_one",
        title: "Test",
        body: "Body",
      }),
      "/tmp",
    ),
  ).rejects.toMatchObject({ code: "GH_INVALID_ACTION_INPUT" });
});

test("creates a reply only in its bound discussion and verifies its returned node", async () => {
  const { collaboration, graphql } = adapter((query, variables) => {
    if (query.startsWith("mutation")) {
      expect(variables).toEqual({
        input: { discussionId: "D_one", replyToId: "DC_one", body: "Reply body" },
      });
      return { addDiscussionComment: { comment: comment({ id: "DC_reply", body: "Reply body" }) } };
    }
    return {
      node: comment({
        id: variables.id as string,
        body: variables.id === "DC_reply" ? "Reply body" : "Comment body",
      }),
    };
  });
  const receipt = await collaboration.perform(
    address("discussion-comments/DC_one/reply"),
    '{"body":"Reply body"}',
    "/tmp",
  );
  expect(receipt).toMatchObject({
    source: "github://owner/repo/discussion-comments/DC_reply",
    id: "DC_reply",
    effect: "applied",
  });
  expect(graphql.mock.calls.filter(([query]) => query.startsWith("mutation"))).toHaveLength(1);
});

test("rejects replyToId from a different discussion even in the same repository", async () => {
  const { collaboration, graphql } = adapter((query) =>
    query.includes("GithubDiscussionComment")
      ? { node: comment({ discussion: discussion({ id: "D_other", number: 8 }) }) }
      : { repository: { ...repo, discussion: discussion() } },
  );
  await expect(
    collaboration.perform(
      address("discussions/3/comments/new"),
      '{"body":"Reply","replyToId":"DC_one"}',
      "/tmp",
    ),
  ).rejects.toMatchObject({ code: "GH_IDENTITY_MISMATCH", effect: "not-applied" });
  expect(graphql.mock.calls.every(([query]) => !query.startsWith("mutation"))).toBe(true);
});

test("rejects a thread node from another PR before resolution", async () => {
  const { collaboration, graphql } = adapter(() => ({
    node: thread({ pullRequest: { number: 8 } }),
  }));
  await expect(
    collaboration.perform(address("pulls/7/threads/PRRT_one/resolve"), "{}", "/tmp"),
  ).rejects.toMatchObject({ code: "GH_IDENTITY_MISMATCH", effect: "not-applied" });
  expect(graphql.mock.calls.every(([query]) => !query.startsWith("mutation"))).toBe(true);
});

test("resolves the verified thread once and rereads its state", async () => {
  let isResolved = false;
  const { collaboration, graphql } = adapter((query, variables) => {
    if (query.startsWith("mutation")) {
      expect(variables).toEqual({ input: { threadId: "PRRT_one" } });
      isResolved = true;
      return { resolveReviewThread: { thread: thread({ isResolved }) } };
    }
    return { node: thread({ isResolved }) };
  });
  const receipt = await collaboration.perform(
    address("pulls/7/threads/PRRT_one/resolve"),
    "{}",
    "/tmp",
  );
  expect(receipt).toMatchObject({
    source: "github://owner/repo/pulls/7/threads/PRRT_one",
    effect: "applied",
  });
  expect(graphql.mock.calls.filter(([query]) => query.startsWith("mutation"))).toHaveLength(1);
  expect(
    (await collaboration.read(address("pulls/7/threads/PRRT_one#resolved"), "/tmp")).content,
  ).toBe("true");
});

test("discussion search enforces repository ownership and rejects scope overrides", async () => {
  const { collaboration, graphql } = adapter((_query, variables) => {
    expect(variables).toMatchObject({ query: "repo:owner/repo fixture", first: 3, after: null });
    return { search: { nodes: [discussion()], pageInfo, discussionCount: 1 } };
  });
  const request = {
    kind: "discussions",
    term: "fixture",
    repository: "owner/repo",
    scope: "github://owner/repo",
    limit: 3,
  };
  expect(await collaboration.discover(request, "/tmp")).toMatchObject({
    complete: true,
    items: [{ id: "D_one", title: "Fixture", url: "github://owner/repo/discussions/3" }],
  });
  await expect(
    collaboration.discover({ ...request, term: "repo:other/repo" }, "/tmp"),
  ).rejects.toMatchObject({ code: "GH_SEARCH_SCOPE_OVERRIDE" });
  expect(graphql).toHaveBeenCalledTimes(1);
  const foreign = adapter(() => ({
    search: {
      nodes: [discussion({ repository: { nameWithOwner: "foreign/repo" } })],
      pageInfo,
      discussionCount: 1,
    },
  }));
  await expect(foreign.collaboration.discover(request, "/tmp")).rejects.toMatchObject({
    code: "GH_IDENTITY_MISMATCH",
  });
});

test("creates a discussion using the category's verified repository and rereads its exact fields", async () => {
  const { collaboration } = adapter((query, variables) => {
    if (query.includes("GithubCategory"))
      return { node: { __typename: "DiscussionCategory", id: "C_one", repository: repo } };
    if (query.startsWith("mutation")) {
      expect(variables).toEqual({
        input: {
          repositoryId: "R_repo",
          categoryId: "C_one",
          title: "Created",
          body: "Created body",
        },
      });
      return {
        createDiscussion: { discussion: discussion({ title: "Created", body: "Created body" }) },
      };
    }
    return {
      repository: { ...repo, discussion: discussion({ title: "Created", body: "Created body" }) },
    };
  });
  expect(
    await collaboration.perform(
      address("discussions/new"),
      '{"categoryId":"C_one","title":"Created","body":"Created body"}',
      "/tmp",
    ),
  ).toMatchObject({ source: "github://owner/repo/discussions/3", id: "D_one", effect: "applied" });
});

test("keeps replies and categories as separate bounded metadata connections", async () => {
  const { collaboration } = adapter((query) =>
    query.includes("GithubDiscussionReplies")
      ? { node: comment({ replies: { nodes: [comment({ id: "DC_reply" })], pageInfo } }) }
      : {
          repository: {
            ...repo,
            discussionCategories: {
              nodes: [
                {
                  __typename: "DiscussionCategory",
                  id: "C_one",
                  name: "General",
                  repository: repo,
                },
              ],
              pageInfo,
            },
          },
        },
  );
  const replies = await collaboration.read(address("discussion-comments/DC_one/replies"), "/tmp");
  expect(replies.content).toContain("github://owner/repo/discussion-comments/DC_reply");
  expect(replies.content).not.toContain("Comment body");
  expect((await collaboration.read(address("discussions/categories"), "/tmp")).content).toContain(
    "categoryId C_one",
  );
});

test("verifies every listed PR thread's parent and preserves its exact continuation", async () => {
  const { collaboration } = adapter(() => ({
    repository: {
      ...repo,
      pullRequest: {
        number: 7,
        reviewThreads: {
          nodes: [thread()],
          pageInfo: { hasNextPage: true, endCursor: "thread-next" },
        },
      },
    },
  }));
  const result = await collaboration.read(address("pulls/7/threads?per_page=1"), "/tmp");
  expect(result.content).toContain("github://owner/repo/pulls/7/threads/PRRT_one");
  expect(result.content).toContain(
    "github://owner/repo/pulls/7/threads?per_page=1&cursor=thread-next",
  );
  const foreign = adapter(() => ({
    repository: {
      ...repo,
      pullRequest: {
        number: 7,
        reviewThreads: { nodes: [thread({ pullRequest: { number: 8 } })], pageInfo },
      },
    },
  }));
  await expect(
    foreign.collaboration.read(address("pulls/7/threads"), "/tmp"),
  ).rejects.toMatchObject({ code: "GH_IDENTITY_MISMATCH" });
});

test("reports malformed acknowledged mutations as unknown, never as a local refusal", async () => {
  const { collaboration } = adapter((query) =>
    query.startsWith("mutation") ? null : { node: thread() },
  );
  await expect(
    collaboration.perform(address("pulls/7/threads/PRRT_one/resolve"), "{}", "/tmp"),
  ).rejects.toMatchObject({ code: "GH_INVALID_RESPONSE", effect: "unknown" });
});

test("rejects a discussion revision changed during the final identity reread before saving", async () => {
  let reads = 0;
  const { collaboration, graphql } = adapter(() => ({
    repository: {
      ...repo,
      discussion: discussion({ body: ++reads === 3 ? "Changed during prepare" : "Original body" }),
    },
  }));
  const target = address("discussions/3#body");
  const expected = await collaboration.read(target, "/tmp");
  await expect(collaboration.save(target, expected, "Replacement", "/tmp")).rejects.toMatchObject({
    code: "GH_STALE_RESOURCE",
    effect: "not-applied",
  });
  expect(graphql.mock.calls.every(([query]) => !query.startsWith("mutation"))).toBe(true);
});
test("preserves an uncertain GraphQL mutation effect without retrying or leaking errors", async () => {
  const { collaboration, graphql } = adapter((query) => {
    if (query.startsWith("mutation")) throw new GithubApiError("GH_REQUEST_FAILED", "unknown");
    return { node: thread() };
  });
  await expect(
    collaboration.perform(address("pulls/7/threads/PRRT_one/resolve"), "{}", "/tmp"),
  ).rejects.toMatchObject({ code: "GH_REQUEST_FAILED", effect: "unknown" });
  expect(graphql.mock.calls.filter(([query]) => query.startsWith("mutation"))).toHaveLength(1);
});
