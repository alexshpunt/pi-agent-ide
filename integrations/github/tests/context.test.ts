import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { GithubContext } from "#github/context.ts";
import { GithubApiError } from "#github/client.ts";

function snapshot(result: Awaited<ReturnType<GithubContext["read"]>>) {
  assert.ok(result);
  return result;
}
function snapshotBytes(result: Awaited<ReturnType<GithubContext["read"]>>) {
  const bytes = snapshot(result).bytes;
  assert.ok(bytes);
  return bytes;
}
function firstQuery<T>(queries: T[]): T {
  const query = queries.at(0);
  assert.ok(query !== undefined);
  return query;
}
function lastQuery<T>(queries: T[]): T {
  const query = queries.at(-1);
  assert.ok(query !== undefined);
  return query;
}

const head = "a".repeat(40);
const base = "b".repeat(40);
const repo = "/repos/example/project";
const native = "https://github.com/example/project";
const notFound = () => new GithubApiError("GH_NOT_FOUND", "not-applied", 404);
interface Call {
  method: string;
  route: string;
  input?: unknown;
}
function fixture(
  responses: Record<string, unknown>,
  graphql?: (variables: Record<string, unknown>, query: string) => unknown,
  raw?: (route: string, options: unknown) => Uint8Array,
) {
  const calls: Call[] = [];
  const queries: { variables: Record<string, unknown>; query: string }[] = [];
  const rawCalls: { method: string; route: string; options: unknown }[] = [];
  const context = new GithubContext(
    async () =>
      ({
        async rest(method: string, route: string, input?: unknown) {
          calls.push({ method, route, input });
          if (!(route in responses)) throw notFound();
          const value =
            typeof responses[route] === "function"
              ? (responses[route] as () => unknown)()
              : responses[route];
          if (value instanceof Error) throw value;
          return value && typeof value === "object" && "data" in value ? value : { data: value };
        },
        async request(
          method: string,
          route: string,
          _input?: unknown,
          _signal?: AbortSignal,
          options?: unknown,
        ) {
          rawCalls.push({ method, route, options });
          if (!raw) throw new Error("Unexpected raw request");
          return {
            status: 200,
            contentType: "application/octet-stream",
            bytes: raw(route, options),
          };
        },
        async graphql(query: string, variables: Record<string, unknown>) {
          queries.push({ query, variables });
          if (!graphql) throw new Error("Unexpected GraphQL");
          return graphql(variables, query);
        },
      }) as never,
  );
  return { context, calls, queries, rawCalls };
}
const pull = {
  number: 12,
  html_url: `${native}/pull/12`,
  head: { sha: head },
  base: { sha: base },
};

test("unrelated sources stay outside the context layer", async () => {
  const { context, calls } = fixture({});
  for (const source of [
    "README.md",
    "https://example.com/actions/runs/1",
    `${native}/issues/1`,
    "https://api.github.com/rate_limit",
  ])
    expect(await context.read(source, ".")).toBeUndefined();
  expect(calls).toEqual([]);
});

test("PR check context links exact head checks and runs without executing or fetching them", async () => {
  const { context, calls } = fixture({ [`${repo}/pulls/12`]: pull });
  const result = await context.read(`${native}/pull/12/checks`, ".");
  expect(snapshot(result).content).toContain(`/commits/${head}/check-runs`);
  expect(snapshot(result).content).toContain(`actions/runs?head_sha=${head}`);
  expect(calls).toEqual([{ method: "GET", route: `${repo}/pulls/12`, input: undefined }]);
});

test("a PR response cannot substitute another PR or invalid head SHA", async () => {
  for (const value of [
    { ...pull, number: 99 },
    { ...pull, head: { sha: "branch" } },
  ]) {
    const { context } = fixture({ [`${repo}/pulls/12`]: value });
    await expect(context.read(`${native}/pull/12/checks`, ".")).rejects.toMatchObject({
      effect: "not-applied",
    });
  }
});

test("workflow runs link jobs logs artifacts PRs and exact head context", async () => {
  const { context, calls } = fixture({
    [`${repo}/actions/runs/7`]: {
      id: 7,
      name: "Build",
      status: "completed",
      conclusion: "failure",
      head_sha: head,
      html_url: `${native}/actions/runs/7`,
      repository: { full_name: "example/project" },
      pull_requests: [{ number: 12 }],
    },
  });
  const result = await context.read(`${native}/actions/runs/7`, ".");
  expect(snapshot(result).content).toContain("conclusion: failure");
  expect(snapshot(result).content).toContain("actions/runs/7/jobs");
  expect(snapshot(result).content).toContain("actions/runs/7/logs");
  expect(snapshot(result).content).toContain("actions/runs/7/artifacts");
  expect(snapshot(result).content).toContain("github://example/project/pulls/12");
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

test("job context exposes steps and checks the run in its browser path", async () => {
  const data = {
    id: 8,
    run_id: 7,
    name: "Unit tests",
    steps: [{ number: 1, name: "Test", status: "completed", conclusion: "success" }],
  };
  const { context } = fixture({ [`${repo}/actions/jobs/8`]: data });
  expect(snapshot(await context.read(`${native}/actions/runs/7/job/8`, ".")).content).toContain(
    "1 Test: completed / success",
  );
  const mismatch = fixture({ [`${repo}/actions/jobs/8`]: { ...data, run_id: 9 } });
  await expect(mismatch.context.read(`${native}/actions/runs/7/job/8`, ".")).rejects.toMatchObject({
    code: "GH_IDENTITY_MISMATCH",
  });
});

test("a forged Actions owner or numeric resource id is rejected", async () => {
  for (const data of [
    { id: 9, repository: { full_name: "example/project" } },
    { id: 7, repository: { full_name: "other/project" } },
    { id: 7, html_url: "https://github.com/other/project/actions/runs/7" },
  ]) {
    const { context } = fixture({ [`${repo}/actions/runs/7`]: data });
    await expect(context.read(`${native}/actions/runs/7`, ".")).rejects.toMatchObject({
      code: "GH_IDENTITY_MISMATCH",
    });
  }
});

test("collection continuation keeps the endpoint and filters and advances", async () => {
  for (const next of [
    `https://api.github.com${repo}/actions/jobs?page=2&per_page=1`,
    `https://api.github.com${repo}/actions/runs?page=1&per_page=1`,
    `https://api.github.com${repo}/actions/runs?page=2&per_page=1&status=failure`,
  ]) {
    const { context } = fixture({
      [`${repo}/actions/runs?per_page=1`]: { data: { workflow_runs: [] }, next },
    });
    await expect(context.read(`${native}/actions/runs?per_page=1`, ".")).rejects.toMatchObject({
      code: "GH_INVALID_CONTINUATION",
    });
  }
  const next = `https://api.github.com${repo}/actions/runs?per_page=1&page=2`;
  const { context } = fixture({
    [`${repo}/actions/runs?per_page=1`]: { data: { workflow_runs: [], total_count: 3 }, next },
  });
  expect(snapshot(await context.read(`${native}/actions/runs?per_page=1`, ".")).content).toContain(
    next,
  );
});

test("numeric repository pagination is verified before canonical mapping", async () => {
  const { context, calls } = fixture({
    [`${repo}/actions/runs?per_page=1`]: {
      data: { workflow_runs: [] },
      next: "https://api.github.com/repositories/42/actions/runs?per_page=1&page=2",
    },
    [repo]: { id: 42, full_name: "example/project" },
  });
  expect(snapshot(await context.read(`${native}/actions/runs?per_page=1`, ".")).content).toContain(
    `${repo}/actions/runs?per_page=1&page=2`,
  );
  expect(calls).toHaveLength(2);
});

const project = {
  id: "PVT_1",
  number: 2,
  title: "Delivery",
  url: "https://github.com/orgs/example/projects/2",
  closed: false,
  shortDescription: "Ship it",
};
test("Projects stay owner-scoped and expose fields and item navigation", async () => {
  const { context, queries } = fixture({}, () => ({
    owner: { login: "example", projectV2: project },
  }));
  const result = await context.read(project.url, ".");
  expect(snapshot(result).content).toContain("github://orgs/example/projects/2/fields");
  expect(snapshot(result).content).toContain("github://orgs/example/projects/2/items");
  expect(firstQuery(queries).variables).toEqual({ owner: "example", number: 2 });
  const wrongOwner = fixture({}, () => ({ owner: { login: "other", projectV2: project } }));
  await expect(wrongOwner.context.read(project.url, ".")).rejects.toMatchObject({
    code: "GH_IDENTITY_MISMATCH",
  });
});

test("Project items link cross-repository content and preserve field and cursor coverage", async () => {
  const page = {
    nodes: [
      {
        id: "PVTI_1",
        type: "ISSUE",
        content: {
          __typename: "Issue",
          title: "Bug",
          number: 3,
          url: "https://github.com/other/repo/issues/3",
          repository: { nameWithOwner: "other/repo" },
        },
        fieldValues: {
          nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo" }],
          pageInfo: { hasNextPage: true, endCursor: "values-2" },
        },
      },
    ],
    pageInfo: { hasNextPage: true, endCursor: "items-2" },
  };
  const { context } = fixture({}, () => ({
    owner: { login: "example", projectV2: { ...project, items: page } },
  }));
  const result = await context.read("github://orgs/example/projects/2/items?per_page=1", ".");
  expect(snapshot(result).content).toContain("github://other/repo/issues/3");
  expect(snapshot(result).content).toContain("Field values are incomplete");
  expect(snapshot(result).content).toContain("items?per_page=1&cursor=items-2");
});

test("Project field pages reject a repeated cursor", async () => {
  const fields = {
    nodes: [{ id: "PVTF_1", name: "Status" }],
    pageInfo: { hasNextPage: true, endCursor: "same" },
  };
  const { context } = fixture({}, () => ({
    owner: { login: "example", projectV2: { ...project, fields } },
  }));
  await expect(
    context.read("github://orgs/example/projects/2/fields?cursor=same", "."),
  ).rejects.toMatchObject({ code: "GH_INVALID_CONTINUATION" });
});

const projectView = (number = 1, user = false, filter: string | null = "status:Todo") => ({
  id: `PVTV_${number}`,
  number,
  name: "Todo board",
  layout: "BOARD_LAYOUT",
  filter,
  project: {
    number: 2,
    url: `https://github.com/${user ? "users" : "orgs"}/example/projects/2`,
    owner: { __typename: user ? "User" : "Organization", login: "example" },
  },
  fields: connection([{ id: "PVTF_1", name: "Status", dataType: "SINGLE_SELECT" }]),
});
const projectReply = (extra: Record<string, unknown>, user = false) => ({
  owner: {
    login: "example",
    projectV2: { ...project, url: projectView(1, user).project.url, ...extra },
  },
});

test("Project cards advertise views and views pages retain their own cursors", async () => {
  const { context, queries } = fixture({}, (variables) =>
    projectReply({
      views: connection([projectView(variables.after ? 2 : 1)], variables.after ? null : "views-2"),
    }),
  );
  expect(snapshot(await context.read(project.url, ".")).content).toContain(
    "Views: github://orgs/example/projects/2/views",
  );
  const first = await context.read("github://orgs/example/projects/2/views?per_page=1", ".");
  expect(snapshot(first).content).toContain("View: github://orgs/example/projects/2/views/1");
  expect(snapshot(first).content).toContain("views?per_page=1&cursor=views-2");
  expect(snapshot(first).content).not.toContain("/views/2");
  const second = await context.read(
    "github://orgs/example/projects/2/views?per_page=1&cursor=views-2",
    ".",
  );
  expect(snapshot(second).content).toContain("View: github://orgs/example/projects/2/views/2");
  expect(lastQuery(queries).variables.after).toBe("views-2");
});

test("user and organization view cards verify parent identity and expose saved filters and fields", async () => {
  for (const user of [false, true]) {
    const view = projectView(1, user);
    const { context, queries, calls } = fixture({}, () => projectReply({ view }, user));
    const source = `${view.project.url}/views/1`;
    const result = await context.read(source, ".");
    expect(snapshot(result).content).toContain("Saved filter: status:Todo");
    expect(snapshot(result).content).toContain(
      `Items: github://${user ? "users" : "orgs"}/example/projects/2/views/1/items`,
    );
    expect(snapshot(result).content).toContain("Status");
    expect(snapshot(result).content).toContain("sorting and grouping are not reproduced");
    expect(firstQuery(queries).variables.view).toBe(1);
    expect(calls).toEqual([]);
  }
});

test("view cards describe unavailable or incomplete visible fields without pretending full coverage", async () => {
  for (const fields of [null, connection([], "fields-2")]) {
    const { context } = fixture({}, () => projectReply({ view: { ...projectView(), fields } }));
    const result = await context.read(`${project.url}/views/1`, ".");
    expect(snapshot(result).content).toContain(
      fields === null ? "Visible fields are unavailable" : "Visible fields are incomplete",
    );
    expect(snapshot(result).content).toContain("https://api.github.com/graphql");
  }
});

test("Project views never accept another parent, owner or view number", async () => {
  for (const change of [
    { number: 9 },
    { project: { ...projectView().project, number: 9 } },
    {
      project: { ...projectView().project, owner: { __typename: "Organization", login: "other" } },
    },
    { project: { ...projectView().project, owner: { __typename: "User", login: "example" } } },
    { project: { ...projectView().project, url: "https://github.com/orgs/other/projects/2" } },
  ]) {
    const { context } = fixture({}, () => projectReply({ view: { ...projectView(), ...change } }));
    await expect(context.read(`${project.url}/views/1`, ".")).rejects.toMatchObject({
      code: "GH_IDENTITY_MISMATCH",
    });
  }
  const missing = fixture({}, () => projectReply({ view: null }));
  await expect(missing.context.read(`${project.url}/views/1`, ".")).rejects.toMatchObject({
    code: "GH_NOT_FOUND",
  });
});

test("view items apply the exact saved filter and keep cross-repository content and pagination", async () => {
  for (const user of [false, true]) {
    const view = projectView(1, user, "status:Todo repo:other/repo");
    const item = {
      id: "PVTI_1",
      type: "ISSUE",
      content: {
        __typename: "Issue",
        title: "Other repo",
        number: 3,
        url: "https://github.com/other/repo/issues/3",
        repository: { nameWithOwner: "other/repo" },
      },
      fieldValues: connection([]),
    };
    const { context, queries } = fixture({}, (variables, query) => {
      if (query.includes("items(")) {
        expect(query).toContain("query:$filter");
        expect(variables.filter).toBe(view.filter);
      }
      return projectReply(
        { view, items: connection([item], variables.after ? null : "items-2") },
        user,
      );
    });
    const result = await context.read(`${view.project.url}/views/1/items?per_page=1`, ".");
    expect(snapshot(result).content).toContain("github://other/repo/issues/3");
    expect(queries).toHaveLength(2);
    expect(firstQuery(queries).query).not.toContain("items(");
    const continuation = /github:\/\/[^\s]+\/views\/1\/items\?per_page=1&cursor=items-2\b/u.exec(
      snapshot(result).content,
    );
    assert.ok(continuation);
    const second = await context.read(continuation[0], ".");
    expect(snapshot(second).content).toContain("github://other/repo/issues/3");
    expect(snapshot(second).source).toBe(continuation[0]);
    // The card may echo its own source, but must not offer it again as a continuation.
    expect(snapshot(second).content.split(continuation[0]).length).toBeLessThanOrEqual(2);
    expect(lastQuery(queries).variables.after).toBe("items-2");
    expect(lastQuery(queries).variables.filter).toBe(view.filter);
  }
});

test("unavailable filters give a limitation without reading unfiltered parent items", async () => {
  const { context, queries } = fixture({}, () =>
    projectReply({ view: projectView(1, false, null) }),
  );
  const result = await context.read(`${project.url}/views/1/items`, ".");
  expect(snapshot(result).content).toContain("Saved filter is unavailable");
  expect(snapshot(result).content).toContain("https://api.github.com/graphql");
  expect(queries).toHaveLength(1);
  expect(firstQuery(queries).query).not.toContain("items(");
});

test("view item reads reject a filter changed between identity and item requests", async () => {
  let count = 0;
  const { context } = fixture({}, () =>
    projectReply({
      view: projectView(1, false, ++count === 1 ? "status:Todo" : "status:Done"),
      items: connection([]),
    }),
  );
  await expect(context.read(`${project.url}/views/1/items`, ".")).rejects.toMatchObject({
    code: "GH_STALE_PROJECT_VIEW",
  });
});

test("view queries and duplicate pagination parameters never get silently dropped", async () => {
  for (const query of [
    "itemId=3",
    "q=status%3ADone",
    "layout=table",
    "cursor=a&cursor=b",
    "per_page=1&per_page=2",
  ]) {
    const { context, queries, calls } = fixture({});
    await expect(context.read(`${project.url}/views/1/items?${query}`, ".")).rejects.toMatchObject({
      code: "GH_UNSUPPORTED_PROJECT_SELECTION",
    });
    expect(queries).toEqual([]);
    expect(calls).toEqual([]);
  }
});

test("view and field connections reject oversized, missing and repeated pagination metadata", async () => {
  const repeated = fixture({}, () => projectReply({ views: connection([projectView()], "same") }));
  await expect(
    repeated.context.read(`${project.url}/views?cursor=same`, "."),
  ).rejects.toMatchObject({ code: "GH_INVALID_CONTINUATION" });
  const tooMany = fixture({}, () =>
    projectReply({ views: connection([projectView(), projectView(2)]) }),
  );
  await expect(tooMany.context.read(`${project.url}/views?per_page=1`, ".")).rejects.toMatchObject({
    code: "GH_INVALID_RESPONSE",
  });
  const fields = fixture({}, () =>
    projectReply({
      view: {
        ...projectView(),
        fields: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
      },
    }),
  );
  await expect(fields.context.read(`${project.url}/views/1`, ".")).rejects.toMatchObject({
    code: "GH_INVALID_CONTINUATION",
  });
});
function content(path: string, text: string) {
  return {
    type: "file",
    path,
    encoding: "base64",
    content: Buffer.from(text).toString("base64"),
    size: Buffer.byteLength(text),
  };
}
test("slash-containing browser refs resolve through commit and content evidence", async () => {
  const { context, calls } = fixture({
    [`${repo}/commits/feature%2Ffix`]: { sha: head },
    [`${repo}/contents/src/a.ts?ref=${head}`]: content("src/a.ts", "one\ntwo\nthree\n"),
  });
  const result = await context.read(`${native}/blob/feature/fix/src/a.ts#L2-L3`, ".");
  expect(snapshot(result).content).toContain(`Commit: ${head}`);
  expect(snapshot(result).content).toContain("Lines: 2-3\n\ntwo\nthree");
  expect(Buffer.from(snapshotBytes(result))).toEqual(Buffer.from("one\ntwo\nthree\n"));
  expect(calls.some((call) => call.route === `${repo}/commits/feature%2Ffix`)).toBe(true);
});

test("ambiguous ref/path interpretations fail rather than choosing the first", async () => {
  const { context } = fixture({
    [`${repo}/commits/main`]: { sha: head },
    [`${repo}/commits/main%2Fsrc`]: { sha: base },
    [`${repo}/contents/src/a.ts?ref=${head}`]: content("src/a.ts", "one"),
    [`${repo}/contents/a.ts?ref=${base}`]: content("a.ts", "two"),
  });
  await expect(context.read(`${native}/blob/main/src/a.ts`, ".")).rejects.toMatchObject({
    code: "GH_AMBIGUOUS_REF",
  });
});

test("directory children use verified commit refs and cannot escape the directory", async () => {
  const { context } = fixture({
    [`${repo}/commits/main`]: { sha: head },
    [`${repo}/contents/src?ref=${head}`]: [
      { type: "file", path: "src/a.ts" },
      { type: "dir", path: "src/lib" },
    ],
  });
  const result = await context.read(`${native}/tree/main/src`, ".");
  expect(snapshot(result).content).toContain(`file?ref=${head}&path=src%2Fa.ts`);
  expect(snapshot(result).content).toContain(`/tree/${head}/src/lib`);
  const wrong = fixture({
    [`${repo}/commits/main`]: { sha: head },
    [`${repo}/contents/src?ref=${head}`]: [{ type: "file", path: "other/a.ts" }],
  });
  await expect(wrong.context.read(`${native}/tree/main/src`, ".")).rejects.toMatchObject({
    code: "GH_IDENTITY_MISMATCH",
  });
});

test("binary file reads preserve original bytes while line anchors reject unavailable lines", async () => {
  const bytes = Buffer.from([0, 1, 255]);
  const { context } = fixture({
    [`${repo}/commits/main`]: { sha: head },
    [`${repo}/contents/file.bin?ref=${head}`]: {
      type: "file",
      path: "file.bin",
      encoding: "base64",
      content: bytes.toString("base64"),
      size: 3,
    },
  });
  const result = await context.read(`${native}/blob/main/file.bin`, ".");
  expect(Buffer.from(snapshotBytes(result))).toEqual(bytes);
  expect(snapshot(result).content).toContain("Binary file");
  const text = fixture({
    [`${repo}/commits/main`]: { sha: head },
    [`${repo}/contents/file.txt?ref=${head}`]: content("file.txt", "one\n"),
  });
  await expect(text.context.read(`${native}/blob/main/file.txt#L2`, ".")).rejects.toMatchObject({
    code: "GH_LINE_OUT_OF_RANGE",
  });
});

test("permission failure during ref resolution is not mistaken for a missing ref", async () => {
  const { context, calls } = fixture({
    [`${repo}/commits/main`]: new GithubApiError("GH_FORBIDDEN", "not-applied", 403),
  });
  await expect(context.read(`${native}/blob/main/a.ts`, ".")).rejects.toMatchObject({
    code: "GH_FORBIDDEN",
  });
  expect(calls).toHaveLength(1);
});

test("release tag and download URLs map verified release and paginated asset identities", async () => {
  const { context } = fixture({
    [`${repo}/releases/tags/v1%2Ftest`]: { id: 6, tag_name: "v1/test" },
    [`${repo}/releases/6/assets?per_page=100`]: {
      data: [{ id: 7, name: "other.zip" }],
      next: `https://api.github.com${repo}/releases/6/assets?per_page=100&page=2`,
    },
    [`https://api.github.com${repo}/releases/6/assets?per_page=100&page=2`]: [
      { id: 8, name: "build.zip" },
    ],
  });
  expect(snapshot(await context.read(`${native}/releases/tag/v1/test`, ".")).content).toContain(
    "github://example/project/releases/6",
  );
  expect(
    snapshot(await context.read(`${native}/releases/download/v1/test/build.zip`, ".")).content,
  ).toContain("raw:github://example/project/releases/assets/8");
  const wrong = fixture({ [`${repo}/releases/tags/v1`]: { id: 6, tag_name: "other" } });
  await expect(wrong.context.read(`${native}/releases/tag/v1`, ".")).rejects.toMatchObject({
    code: "GH_IDENTITY_MISMATCH",
  });
});

const comment = (id: string, numeric: number) => ({
  id,
  url: `${native}/discussions/3#discussioncomment-${numeric}`,
  author: { __typename: "Bot", login: "example-app" },
  discussion: { number: 3, repository: { nameWithOwner: "example/project" } },
});
const connection = (nodes: unknown[], next: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: next !== null, endCursor: next },
});
test("discussion fragments resolve replies through bounded verified node lookup", async () => {
  const parent = { ...comment("DC_parent", 4), replies: connection([], "reply-2") };
  const { context, queries } = fixture({}, (variables) =>
    variables.id
      ? { node: { ...parent, replies: connection([comment("DC_target", 5)]) } }
      : {
          repository: {
            nameWithOwner: "example/project",
            discussion: { number: 3, comments: connection([parent]) },
          },
        },
  );
  const result = await context.read(`${native}/discussions/3#discussioncomment-5`, ".");
  expect(snapshot(result).content).toContain(
    "github://example/project/discussion-comments/DC_target#body",
  );
  expect(snapshot(result).content).toContain("Actor: Bot");
  expect(queries).toHaveLength(2);
});

test("numeric comment lookup never accepts a different discussion and reports incomplete bounds", async () => {
  const wrong = fixture({}, () => ({
    repository: {
      nameWithOwner: "example/project",
      discussion: {
        number: 3,
        comments: connection([
          {
            ...comment("DC_5", 5),
            discussion: { number: 9, repository: { nameWithOwner: "example/project" } },
          },
        ]),
      },
    },
  }));
  await expect(
    wrong.context.read(`${native}/discussions/3#discussioncomment-5`, "."),
  ).rejects.toMatchObject({ code: "GH_IDENTITY_MISMATCH" });
  let page = 0;
  const bounded = fixture({}, () => ({
    repository: {
      nameWithOwner: "example/project",
      discussion: { number: 3, comments: connection([], `page-${++page}`) },
    },
  }));
  await expect(
    bounded.context.read(`${native}/discussions/3#discussioncomment-5`, "."),
  ).rejects.toMatchObject({ code: "GH_COMMENT_LOOKUP_INCOMPLETE" });
  expect(bounded.queries).toHaveLength(20);
});

test("PR diff anchors identify actual files and verify requested side lines in the patch", async () => {
  const path = "src/a.ts";
  const hash = createHash("sha256").update(path).digest("hex");
  const responses = {
    [`${repo}/pulls/12`]: pull,
    [`${repo}/pulls/12/files?per_page=100`]: [
      { filename: path, patch: "@@ -1,2 +1,3 @@\n old\n+new\n tail" },
    ],
  };
  const { context } = fixture(responses);
  const result = await context.read(`${native}/pull/12/files#diff-${hash}R2`, ".");
  expect(snapshot(result).content).toContain("Lines: 2-2");
  expect(snapshot(result).content).toContain(`file?ref=${head}&path=src%2Fa.ts`);
  await expect(context.read(`${native}/pull/12/files#diff-${hash}R8`, ".")).rejects.toMatchObject({
    code: "GH_LINE_NOT_IN_PATCH",
  });
  await expect(
    context.read(`${native}/pull/12/files#diff-${"0".repeat(64)}R1`, "."),
  ).rejects.toMatchObject({ code: "GH_NOT_FOUND" });
});

test("commit and comparison views keep parent and file reads lazy", async () => {
  const { context, calls } = fixture({
    [`${repo}/commits/${head}`]: {
      sha: head,
      commit: { message: "Fix it" },
      parents: [{ sha: base }],
      files: [{ filename: "a.ts", status: "modified" }],
    },
    [`${repo}/compare/${base}...${head}`]: {
      status: "ahead",
      head_commit: { sha: head },
      files: [{ filename: "a.ts", status: "modified" }],
    },
  });
  expect(snapshot(await context.read(`${native}/commit/${head}`, ".")).content).toContain(
    `/commits/${base}`,
  );
  expect(
    snapshot(await context.read(`${native}/compare/${base}...${head}`, ".")).content,
  ).toContain(`file?ref=${head}&path=a.ts`);
  expect(calls).toHaveLength(2);
});

test("dedicated views do not swallow arbitrary Actions or explicit Projects REST resources", async () => {
  const { context, calls } = fixture({});
  expect(await context.read(`https://api.github.com${repo}/actions/secrets`, ".")).toBeUndefined();
  expect(
    await context.read("https://api.github.com/orgs/example/projectsV2/2/items?page=2", "."),
  ).toBeUndefined();
  expect(calls).toEqual([]);
});

test("Project view selections are not silently discarded", async () => {
  const { context, calls } = fixture({});
  await expect(
    context.read("https://github.com/orgs/example/projects/2/views/1?itemId=3", "."),
  ).rejects.toMatchObject({ code: "GH_UNSUPPORTED_PROJECT_SELECTION" });
  expect(calls).toEqual([]);
});

test("an exact commit cannot be replaced with a different SHA", async () => {
  const { context } = fixture({ [`${repo}/commits/${head}`]: { sha: base } });
  await expect(context.read(`${native}/commit/${head}`, ".")).rejects.toMatchObject({
    code: "GH_IDENTITY_MISMATCH",
  });
});

test("left diff anchors use the verified merge base and trailing newlines are not patch lines", async () => {
  const path = "a.ts";
  const hash = createHash("sha256").update(path).digest("hex");
  const mergeBase = "c".repeat(40);
  const { context } = fixture({
    [`${repo}/pulls/12`]: pull,
    [`${repo}/pulls/12/files?per_page=100`]: [{ filename: path, patch: "@@ -1 +1 @@\n old\n" }],
    [`${repo}/compare/${base}...${head}`]: {
      base_commit: { sha: base },
      head_commit: { sha: head },
      merge_base_commit: { sha: mergeBase },
    },
  });
  expect(
    snapshot(await context.read(`${native}/pull/12/files#diff-${hash}L1`, ".")).content,
  ).toContain(`file?ref=${mergeBase}&path=a.ts`);
  await expect(context.read(`${native}/pull/12/files#diff-${hash}R2`, ".")).rejects.toMatchObject({
    code: "GH_LINE_NOT_IN_PATCH",
  });
});
function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

test("large browser files use raw Accept at the verified commit and preserve original bytes", async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 37, "a");
  const route = `${repo}/contents/src/large.txt?ref=${head}`;
  const metadata = {
    type: "file",
    path: "src/large.txt",
    encoding: "none",
    content: "",
    size: bytes.length,
    sha: gitBlobSha(bytes),
    download_url: "https://untrusted.example/other.txt",
  };
  const { context, rawCalls } = fixture(
    {
      [`${repo}/commits/main`]: { sha: head },
      [route]: metadata,
    },
    undefined,
    (actual) => {
      expect(actual).toBe(route);
      return bytes;
    },
  );
  const result = await context.read(`${native}/blob/main/src/large.txt`, ".");
  expect(Buffer.from(snapshotBytes(result)).equals(bytes)).toBe(true);
  expect(snapshot(result).content).toContain(`Commit: ${head}`);
  expect(rawCalls).toEqual([
    { method: "GET", route, options: { accept: "application/vnd.github.raw+json" } },
  ]);
});

test("raw browser file size and Git blob identity must both match verified metadata", async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 1, "b");
  const route = `${repo}/contents/large.txt?ref=${head}`;
  for (const metadata of [
    { sha: "0".repeat(40), size: bytes.length },
    { sha: gitBlobSha(bytes), size: bytes.length - 1 },
  ]) {
    const { context } = fixture(
      {
        [`${repo}/commits/main`]: { sha: head },
        [route]: { type: "file", path: "large.txt", encoding: "none", content: "", ...metadata },
      },
      undefined,
      () => bytes,
    );
    await expect(context.read(`${native}/blob/main/large.txt`, ".")).rejects.toMatchObject({
      code: "GH_FILE_CONTENT_MISMATCH",
      effect: "not-applied",
    });
  }
});

test("oversized raw browser files fail before downloading", async () => {
  const { context, rawCalls } = fixture(
    {
      [`${repo}/commits/main`]: { sha: head },
      [`${repo}/contents/large.txt?ref=${head}`]: {
        type: "file",
        path: "large.txt",
        encoding: "none",
        content: "",
        size: 2 * 1024 * 1024 + 1,
        sha: head,
      },
    },
    undefined,
    () => Buffer.alloc(0),
  );
  await expect(context.read(`${native}/blob/main/large.txt`, ".")).rejects.toMatchObject({
    code: "GH_RESPONSE_TOO_LARGE",
  });
  expect(rawCalls).toEqual([]);
});

test("browser refs continue past a verified missing-commit response, not arbitrary 422 failures", async () => {
  const responses = {
    [`${repo}/commits/verification`]: new GithubApiError("GH_NOT_FOUND", "not-applied", 422),
    [`${repo}/commits/verification%2Ffixture`]: { sha: head },
    [`${repo}/contents?ref=${head}`]: [],
  };
  const { context } = fixture(responses);
  expect(
    snapshot(await context.read(`${native}/tree/verification/fixture`, ".")).content,
  ).toContain(`Commit: ${head}`);
  const invalid = fixture({
    ...responses,
    [`${repo}/commits/verification`]: new GithubApiError("GH_HTTP_ERROR", "not-applied", 422),
  });
  await expect(
    invalid.context.read(`${native}/tree/verification/fixture`, "."),
  ).rejects.toMatchObject({ code: "GH_HTTP_ERROR" });
});
test("tag lookup can return a draft browser alias with a different requested tag", async () => {
  const alias = "untagged-67ff37c998e760454ac7";
  const browser = `${native}/releases/tag/${alias}`;
  const { context, calls } = fixture({
    [`${repo}/releases/tags/${alias}`]: {
      id: 6,
      tag_name: "requested-verification-tag",
      draft: true,
      html_url: browser,
    },
  });
  const result = await context.read(browser, ".");
  expect(snapshot(result).content).toContain("github://example/project/releases/6");
  expect(snapshot(result).content).toContain(`Browser alias: ${alias}`);
  expect(calls).toHaveLength(1);
  for (const html_url of [
    `${native}/releases/tag/other`,
    "https://github.com/other/project/releases/tag/" + alias,
  ]) {
    const wrong = fixture({
      [`${repo}/releases/tags/${alias}`]: { id: 6, tag_name: "wanted", html_url },
    });
    await expect(wrong.context.read(browser, ".")).rejects.toMatchObject({
      code: "GH_IDENTITY_MISMATCH",
    });
  }
});
test("an unpublished browser release alias is matched by exact repo-qualified html_url", async () => {
  const alias = "untagged-67ff37c998e760454ac7";
  const browser = `${native}/releases/tag/${alias}`;
  const next = `https://api.github.com${repo}/releases?per_page=100&page=2`;
  const { context, calls } = fixture({
    [`${repo}/releases?per_page=100`]: {
      data: [{ id: 1, tag_name: "other", html_url: `${native}/releases/tag/other` }],
      next,
    },
    [next]: [{ id: 6, tag_name: "requested-verification-tag", draft: true, html_url: browser }],
  });
  const result = await context.read(browser, ".");
  expect(snapshot(result).content).toContain("github://example/project/releases/6");
  expect(snapshot(result).content).toContain("Tag: requested-verification-tag");
  expect(snapshot(result).content).toContain(`Browser alias: ${alias}`);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

test("release alias lookup does not accept a different repository or fall back on forbidden access", async () => {
  const alias = "untagged-deadbeef";
  const wrong = fixture({
    [`${repo}/releases?per_page=100`]: [
      {
        id: 6,
        tag_name: "wanted",
        html_url: `https://github.com/other/project/releases/tag/${alias}`,
      },
    ],
  });
  await expect(wrong.context.read(`${native}/releases/tag/${alias}`, ".")).rejects.toMatchObject({
    code: "GH_IDENTITY_MISMATCH",
  });
  const forbidden = fixture({
    [`${repo}/releases/tags/${alias}`]: new GithubApiError("GH_FORBIDDEN", "not-applied", 403),
  });
  await expect(
    forbidden.context.read(`${native}/releases/tag/${alias}`, "."),
  ).rejects.toMatchObject({ code: "GH_FORBIDDEN" });
  expect(forbidden.calls).toHaveLength(1);
});

test("release alias lookup reports incomplete coverage at its page bound", async () => {
  const responses: Record<string, unknown> = {};
  for (let page = 1; page <= 20; page++) {
    const route =
      page === 1
        ? `${repo}/releases?per_page=100`
        : `https://api.github.com${repo}/releases?per_page=100&page=${page}`;
    responses[route] = {
      data: [],
      next: `https://api.github.com${repo}/releases?per_page=100&page=${page + 1}`,
    };
  }
  const { context, calls } = fixture(responses);
  await expect(context.read(`${native}/releases/tag/untagged-unknown`, ".")).rejects.toMatchObject({
    code: "GH_RELEASE_LOOKUP_INCOMPLETE",
  });
  expect(calls).toHaveLength(21);
});

test("legacy runs links address check-run ids, not Actions job ids", async () => {
  const { context, calls } = fixture({
    [`${repo}/check-runs/7`]: {
      id: 7,
      name: "Custom check",
      status: "completed",
      conclusion: "success",
      html_url: `${native}/actions/runs/44/job/99`,
    },
  });
  const result = await context.read(`${native}/runs/7?check_suite_focus=true`, ".");
  expect(snapshot(result).content).toContain(`${repo}/check-runs/7`);
  expect(calls).toEqual([{ method: "GET", route: `${repo}/check-runs/7`, input: undefined }]);
});

test("legacy runs links reject mismatched check-run ids and legacy browser identities", async () => {
  for (const data of [
    { id: 9, html_url: `${native}/runs/7` },
    { id: 7, html_url: `${native}/runs/9` },
  ]) {
    const { context } = fixture({ [`${repo}/check-runs/7`]: data });
    await expect(context.read(`${native}/runs/7`, ".")).rejects.toMatchObject({
      code: "GH_IDENTITY_MISMATCH",
      effect: "not-applied",
    });
  }
});
test("cancelled context reads do not touch the client", async () => {
  const { context, calls } = fixture({});
  await expect(
    context.read(`${native}/actions/runs/7`, ".", AbortSignal.abort()),
  ).rejects.toMatchObject({ code: "GH_CANCELLED", effect: "not-applied" });
  expect(calls).toEqual([]);
});
