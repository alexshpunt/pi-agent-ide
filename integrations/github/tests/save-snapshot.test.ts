import { ok } from "node:assert/strict";
import type { ResourceResolverContext } from "pi-agent-ide/api/resource";
import { expect, test } from "vitest";
import { GithubBackend } from "#github/backend.ts";
import { GithubClient } from "#github/client.ts";
import { GithubRequestCoordinator } from "#github/request-coordinator.ts";
import { GithubCollaboration } from "#github/collaboration.ts";
import { createGithubResolver } from "#github/resource.ts";

const credentials = {
  identity: {
    login: "snapshot-fixture",
    name: "Snapshot fixture",
    email: "fixture@example.invalid",
  },
  async initialize() {},
  async getToken() {
    return { token: "snapshot-synthetic-token", expiresAt: Date.now() + 3_600_000 };
  },
};
const source = "github://owner/repo/issues/12#body";
const operation = { cwd: "/snapshot-fixture", signal: new AbortController().signal };
async function resolved(
  backend: GithubBackend,
  path = source,
  context: ResourceResolverContext = operation,
) {
  const result = await createGithubResolver(backend).tryResolve(path, context);
  if (result.kind !== "resolved") throw new Error("Expected fixture resource");
  const { resource } = result;
  const { read, write } = resource;
  ok(read && write, "Expected an editable fixture resource");
  return { ...resource, read, write };
}
function restFixture(kind: "issues" | "pulls" = "issues", refuseFirstRead = false) {
  const apiPath = `/repos/owner/repo/${kind}/12`;
  const pagePath = kind === "pulls" ? "pull/12" : "issues/12";
  const calls: string[] = [];
  let revision = 0;
  let body = "Original body";
  let afterSave: "ok" | "unreadable" | "mismatched" = "ok";
  const client = new GithubClient(credentials, {
    coordinator: new GithubRequestCoordinator({ directory: null, mutationIntervalMs: 0 }),
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.pathname).toBe(apiPath);
      const method = init?.method ?? "GET";
      calls.push(method);
      if (refuseFirstRead && method === "GET" && calls.length === 1)
        return Response.json({}, { status: 404 });
      if (method === "PATCH") {
        ok(typeof init?.body === "string");
        const patch = JSON.parse(init.body) as { body: string };
        body = patch.body;
        revision++;
      }
      if (method === "GET" && revision > 0 && afterSave === "unreadable")
        throw new Error("Synthetic lost verification response");
      return Response.json({
        number: 12,
        title: "Fixture",
        body:
          method === "GET" && revision > 0 && afterSave === "mismatched" ? "Unexpected body" : body,
        updated_at: `revision-${revision}`,
        html_url: `https://github.com/owner/repo/${pagePath}`,
      });
    },
  });
  return {
    backend: new GithubBackend(async () => client),
    calls,
    changeExternally() {
      body = "External edit";
      revision++;
    },
    verification(value: typeof afterSave) {
      afterSave = value;
    },
  };
}

test("queued PR body editors capture their snapshots after taking the reservation", async () => {
  const fixture = restFixture("pulls");
  const pull = "github://owner/repo/pulls/12#body";
  const reservation = { ...operation, deferSnapshot: true } as const;
  const first = await resolved(fixture.backend, pull, reservation);
  const second = await resolved(
    fixture.backend,
    "https://github.com/owner/repo/pull/12#body",
    reservation,
  );
  expect(first.source).toBe(pull);
  expect(second.source).toBe(pull);
  expect(fixture.calls).toEqual([]);

  expect(await first.read(operation)).toEqual([{ type: "text", text: "Original body" }]);
  await first.write([{ type: "text", text: "First replacement" }], operation);
  expect(await second.read(operation)).toEqual([{ type: "text", text: "First replacement" }]);
  await second.write([{ type: "text", text: "Second replacement" }], operation);
  expect(await second.read(operation)).toEqual([{ type: "text", text: "Second replacement" }]);
  expect(fixture.calls).toEqual(["GET", "GET", "PATCH", "GET", "GET", "GET", "PATCH", "GET"]);
});

test("a failed queued PR body read does not retry or send a write", async () => {
  const fixture = restFixture("pulls", true);
  const resource = await resolved(fixture.backend, "github://owner/repo/pulls/12#body", {
    ...operation,
    deferSnapshot: true,
  });
  await expect(resource.read(operation)).rejects.toMatchObject({ effect: "not-applied" });
  await expect(
    resource.write([{ type: "text", text: "Overwrite" }], operation),
  ).rejects.toMatchObject({
    effect: "not-applied",
  });
  expect(fixture.calls).toEqual(["GET"]);
});

test("an issue resource reuses its verified saved snapshot and keeps the next edit fresh", async () => {
  const fixture = restFixture();
  const resource = await resolved(fixture.backend);
  await resource.write([{ type: "text", text: "First replacement" }], operation);
  expect(fixture.calls).toEqual(["GET", "GET", "PATCH", "GET"]);
  expect(await resource.read(operation)).toEqual([{ type: "text", text: "First replacement" }]);
  expect(fixture.calls).toHaveLength(4);

  await resource.write([{ type: "text", text: "Second replacement" }], operation);
  expect(fixture.calls).toEqual(["GET", "GET", "PATCH", "GET", "GET", "PATCH", "GET"]);
  expect(await resource.read(operation)).toEqual([{ type: "text", text: "Second replacement" }]);
});

test("reusing a saved snapshot still rejects an external edit before dispatch", async () => {
  const fixture = restFixture();
  const resource = await resolved(fixture.backend);
  await resource.write([{ type: "text", text: "First replacement" }], operation);
  fixture.changeExternally();
  await expect(
    resource.write([{ type: "text", text: "Overwrite" }], operation),
  ).rejects.toMatchObject({
    code: "GH_STALE_RESOURCE",
    effect: "not-applied",
  });
  expect(fixture.calls).toEqual(["GET", "GET", "PATCH", "GET", "GET"]);
});

test.each([
  ["unreadable", "GH_SAVE_UNVERIFIED"],
  ["mismatched", "GH_SAVED_CONTENT_MISMATCH"],
] as const)(
  "a %s post-save response remains unknown and never replays the issue mutation",
  async (failure, code) => {
    const fixture = restFixture();
    const resource = await resolved(fixture.backend);
    fixture.verification(failure);
    await expect(
      resource.write([{ type: "text", text: "Replacement" }], operation),
    ).rejects.toMatchObject({ code, effect: "unknown" });
    expect(fixture.calls).toEqual(["GET", "GET", "PATCH", "GET"]);
  },
);

function collaborationFixture(kind: "discussion" | "comment" | "resolved") {
  const calls: string[] = [];
  let body = "Original body";
  let revision = 0;
  let afterSave: "ok" | "unreadable" | "mismatched" = "ok";
  const repository = { id: "R_repo", nameWithOwner: "owner/repo" };
  const discussion = () => ({
    __typename: "Discussion",
    id: "D_one",
    number: 3,
    title: "Fixture",
    body,
    updatedAt: `revision-${revision}`,
    url: "https://github.com/owner/repo/discussions/3",
    repository,
    category: { id: "C_one" },
  });
  const comment = () => ({
    __typename: "DiscussionComment",
    id: "DC_one",
    body: revision > 0 && afterSave === "mismatched" ? "Unexpected body" : body,
    updatedAt: `revision-${revision}`,
    url: "https://github.com/owner/repo/discussions/3#discussioncomment-42",
    discussion: discussion(),
  });
  const thread = () => ({
    __typename: "PullRequestReviewThread",
    id: "PRRT_one",
    isResolved: true,
    isOutdated: false,
    path: "src/a.ts",
    line: 12,
    pullRequest: { number: 7 },
    repository,
    viewerCanResolve: true,
    viewerCanUnresolve: true,
  });
  const client = new GithubClient(credentials, {
    coordinator: new GithubRequestCoordinator({ directory: null, mutationIntervalMs: 0 }),
    fetcher: async (input, init) => {
      expect(new URL(input instanceof Request ? input.url : input).pathname).toBe("/graphql");
      ok(typeof init?.body === "string");
      const { query, variables } = JSON.parse(init.body) as {
        query: string;
        variables: { input: { body: string } };
      };
      const mutation = query.startsWith("mutation");
      calls.push(mutation ? "mutation" : "query");
      if (!mutation && revision > 0 && afterSave === "unreadable")
        throw new Error("Synthetic lost verification response");
      if (mutation) {
        body = variables.input.body;
        revision++;
      }
      const data = mutation
        ? kind === "discussion"
          ? { updateDiscussion: { discussion: discussion() } }
          : { updateDiscussionComment: { comment: comment() } }
        : kind === "discussion"
          ? { repository: { ...repository, discussion: discussion() } }
          : { node: kind === "comment" ? comment() : thread() };
      return Response.json({ data });
    },
  });
  const collaboration = new GithubCollaboration(async () => client);
  const path =
    kind === "discussion"
      ? "discussions/3#body"
      : kind === "comment"
        ? "discussion-comments/DC_one#body"
        : "pulls/7/threads/PRRT_one#resolved";
  return {
    backend: new GithubBackend(async () => client, collaboration),
    calls,
    source: `github://owner/repo/${path}`,
    verification(value: typeof afterSave) {
      afterSave = value;
    },
  };
}

test.each([
  ["comment", ["query", "query", "mutation", "query"]],
  ["discussion", ["query", "query", "query", "mutation", "query"]],
] as const)(
  "a %s resource reuses the verified collaboration snapshot",
  async (kind, expectedCalls) => {
    const fixture = collaborationFixture(kind);
    const resource = await resolved(fixture.backend, fixture.source);
    await resource.write([{ type: "text", text: "Replacement" }], operation);
    expect(fixture.calls).toEqual(expectedCalls);
    expect(await resource.read(operation)).toEqual([{ type: "text", text: "Replacement" }]);
    expect(fixture.calls).toHaveLength(expectedCalls.length);
  },
);

test.each([
  ["unreadable", "GH_SAVE_UNVERIFIED"],
  ["mismatched", "GH_SAVED_CONTENT_MISMATCH"],
] as const)(
  "a %s collaboration verification remains unknown and never replays its mutation",
  async (failure, code) => {
    const fixture = collaborationFixture("comment");
    const resource = await resolved(fixture.backend, fixture.source);
    fixture.verification(failure);
    await expect(
      resource.write([{ type: "text", text: "Replacement" }], operation),
    ).rejects.toMatchObject({ code, effect: "unknown" });
    expect(fixture.calls).toEqual(["query", "query", "mutation", "query"]);
  },
);
test("an already resolved review thread returns the fresh checked snapshot without mutation or refresh", async () => {
  const fixture = collaborationFixture("resolved");
  const resource = await resolved(fixture.backend, fixture.source);
  await resource.write([{ type: "text", text: "true" }], operation);
  expect(fixture.calls).toEqual(["query", "query", "query"]);
  expect(await resource.read(operation)).toEqual([{ type: "text", text: "true" }]);
});
