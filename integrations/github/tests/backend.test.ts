import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { GithubBackend } from "#github/backend.ts";
import { parseGithubAddress } from "#github/address.ts";

function address(source: string) {
  const value = parseGithubAddress(source);
  assert.ok(value);
  return value;
}

test("explicit file reads fetch unavailable inline content as original bytes without changing text scopes", async () => {
  const bytes = Buffer.from("x".repeat(1024 * 1024 + 1));
  const sha = (await import("node:crypto"))
    .createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  const requests: unknown[][] = [];
  const backend = new GithubBackend(
    async () =>
      ({
        rest: async () => ({
          data: { type: "file", path: "large.txt", encoding: "none", size: bytes.length, sha },
        }),
        request: async (...args: unknown[]) => {
          requests.push(args);
          return { status: 200, contentType: "application/vnd.github.raw+json", bytes };
        },
      }) as never,
  );
  const snapshot = await backend.read(
    address("github://example/project/file?ref=main&path=large.txt"),
    ".",
  );
  expect(snapshot.content).toBe(bytes.toString());
  expect(snapshot.bytes && Buffer.from(snapshot.bytes).equals(bytes)).toBe(true);
  expect(requests).toEqual([
    [
      "GET",
      "/repos/example/project/contents/large.txt?ref=main",
      undefined,
      undefined,
      { accept: "application/vnd.github.raw+json" },
    ],
  ]);
});

test("explicit binary files expose original byte windows through the public resolver", async () => {
  const { createGithubResolver } = await import("#github/resource.ts");
  const bytes = Buffer.from([0, 255, 1]);
  const backend = new GithubBackend(
    async () =>
      ({
        rest: async () => ({
          data: {
            type: "file",
            path: "file.bin",
            encoding: "base64",
            size: bytes.length,
            content: bytes.toString("base64"),
          },
        }),
      }) as never,
  );
  const source = "github://example/project/file?ref=main&path=file.bin";
  const resolved = await createGithubResolver(backend).tryResolve(source, { cwd: "." });
  if (resolved.kind !== "resolved") throw new Error("Expected binary resource");
  assert.ok(resolved.resource.read && resolved.resource.readBytes);
  expect(await resolved.resource.read({})).toEqual([
    { type: "text", text: `Binary file; use raw:${source} for original bytes.` },
  ]);
  const window = await resolved.resource.readBytes(1, 1, {});
  expect([...window.bytes]).toEqual([255]);
  expect(window.totalBytes).toBe(3);
});
test("a file cannot silently change blob identity between metadata and raw download", async () => {
  const backend = new GithubBackend(
    async () =>
      ({
        rest: async () => ({
          data: { type: "file", path: "file.bin", encoding: "none", size: 3, sha: "a".repeat(40) },
        }),
        request: async () => ({
          status: 200,
          contentType: "application/octet-stream",
          bytes: Buffer.from([0, 255, 1]),
        }),
      }) as never,
  );
  await expect(
    backend.read(address("github://example/project/file?ref=main&path=file.bin"), "."),
  ).rejects.toMatchObject({ code: "GH_IDENTITY_MISMATCH", effect: "not-applied" });
});
test("queries never silently narrow entity, action or file identity", async () => {
  const { backend, calls } = fixture();
  for (const target of [
    source + "?ref=other",
    "github://example/project/issues/new?page=2",
    "github://example/project/file?ref=main&path=README.md&state=closed",
  ]) {
    await expect(backend.read(address(target), ".")).rejects.toMatchObject({
      code: "GH_UNSUPPORTED_QUERY",
      effect: "not-applied",
    });
  }
  await expect(
    backend.perform(address("github://example/project/issues/new?page=2"), '{"title":"New"}', "."),
  ).rejects.toMatchObject({ code: "GH_UNSUPPORTED_QUERY", effect: "not-applied" });
  expect(calls).toEqual([]);
});

test("review comment cards expose replies to the top-level comment", async () => {
  const client = {
    async rest() {
      return {
        data: {
          id: 9,
          body: "Reply",
          in_reply_to_id: 7,
          pull_request_url: "https://api.github.com/repos/example/project/pulls/12",
          html_url: "https://github.com/example/project/pull/12#discussion_r9",
        },
      };
    },
  };
  const backend = new GithubBackend(async () => client as never);
  expect(
    (await backend.read(address("github://example/project/pulls/comments/9"), ".")).content,
  ).toContain("github://example/project/pulls/12/comments/7/replies/new");
});
const source = "github://example/project/issues/12";

test("a continuation cannot switch collection, filters or move backward", async () => {
  for (const next of [
    "https://api.github.com/repos/example/project/pulls?page=2&per_page=30",
    "https://api.github.com/repos/example/project/issues?page=2&per_page=30&state=closed",
    "https://api.github.com/repos/example/project/issues?page=1&per_page=30",
  ]) {
    const backend = new GithubBackend(
      async () =>
        ({
          async rest() {
            return { data: [], next };
          },
        }) as never,
    );
    await expect(
      backend.read(address("github://example/project/issues"), "."),
    ).rejects.toMatchObject({ code: "GH_INVALID_CONTINUATION", effect: "not-applied" });
  }
});

test("a mismatched issue response cannot become an editable snapshot", async () => {
  const backend = new GithubBackend(
    async () =>
      ({
        async rest() {
          return {
            data: {
              number: 99,
              body: "Other issue",
              html_url: "https://github.com/example/project/issues/99",
            },
          };
        },
      }) as never,
  );
  await expect(backend.read(address(source + "#body"), ".")).rejects.toMatchObject({
    code: "GH_IDENTITY_MISMATCH",
    effect: "not-applied",
  });
});
test("an empty API body stays valid in an editable field snapshot", async () => {
  let issue = {
    number: 12,
    body: null as string | null,
    title: "Empty",
    html_url: "https://github.com/example/project/issues/12",
  };
  const backend = new GithubBackend(
    async () =>
      ({
        async rest(method: string, _path: string, input?: unknown) {
          if (method === "PATCH") {
            assert.ok(input && typeof input === "object");
            issue = { ...issue, ...input };
          }
          return { data: issue };
        },
      }) as never,
  );
  const target = address(source + "#fields");
  const snapshot = await backend.read(target, ".");
  const fields = JSON.parse(snapshot.content) as Record<string, unknown>;
  expect(fields.body).toBe("");
  fields.title = "Changed";
  await backend.save(target, snapshot, JSON.stringify(fields), ".");
  expect(issue.title).toBe("Changed");
});
test("numeric repository pagination is mapped only after repository identity verification", async () => {
  for (const repositoryId of [42, 99]) {
    const calls: string[] = [];
    const backend = new GithubBackend(
      async () =>
        ({
          async rest(_method: string, route: string) {
            calls.push(route);
            if (route === "/repos/example/project")
              return { data: { id: repositoryId, full_name: "example/project" } };
            return {
              data: [],
              next: "https://api.github.com/repositories/42/issues?per_page=1&page=2",
            };
          },
        }) as never,
    );
    const result = backend.read(address("github://example/project/issues?per_page=1"), ".");
    if (repositoryId === 42) {
      expect((await result).content).toContain("github://example/project/issues?per_page=1&page=2");
      expect(calls).toEqual(["/repos/example/project/issues?per_page=1", "/repos/example/project"]);
    } else
      await expect(result).rejects.toMatchObject({
        code: "GH_INVALID_CONTINUATION",
        effect: "not-applied",
      });
  }
});
test("read-only PR cards expose draft and exact branch/commit context", async () => {
  const sha = "1".repeat(40);
  const backend = new GithubBackend(
    async () =>
      ({
        async rest() {
          return {
            data: {
              number: 12,
              title: "Draft",
              draft: true,
              body: "Body",
              html_url: "https://github.com/example/project/pull/12",
              head: { ref: "feature", sha },
              base: { ref: "develop" },
            },
          };
        },
      }) as never,
  );
  const card = await backend.read(address("github://example/project/pulls/12"), ".");
  expect(card.editable).toBe(false);
  expect(card.content).toContain("Draft: true");
  expect(card.content).toContain("Head branch: feature");
  expect(card.content).toContain("Head SHA: " + sha);
  expect(card.content).toContain("Base branch: develop");
});
test("release cards expose the API author rather than assuming an issue-style user field", async () => {
  const backend = new GithubBackend(
    async () =>
      ({
        async rest() {
          return {
            data: {
              id: 7,
              name: "Draft",
              body: "",
              draft: true,
              author: { login: "fixture-app[bot]" },
              html_url: "https://github.com/example/project/releases/tag/fixture",
            },
          };
        },
      }) as never,
  );
  const card = await backend.read(address("github://example/project/releases/7"), ".");
  expect(card.content).toContain("Author: fixture-app[bot]");
  expect(card.content).toContain("Draft: true");
});
function fixture() {
  let issue = {
    number: 12,
    title: "Original",
    body: "First line\nLast line\n",
    state: "open",
    updated_at: "one",
    html_url: "https://github.com/example/project/issues/12",
    labels: [],
    assignees: [],
    milestone: null,
  };
  const calls: unknown[][] = [];
  const client = {
    identity: { login: "app[bot]", name: "app[bot]", email: "app@example.invalid" },
    async rest(method: string, route: string, body?: unknown) {
      calls.push([method, route, body]);
      if (method === "PATCH") issue = { ...issue, ...(body as object), updated_at: "two" };
      return { data: issue };
    },
    async graphql() {
      throw new Error("not used");
    },
  };
  return {
    backend: new GithubBackend(async () => client as never),
    calls,
    external() {
      issue = { ...issue, body: "Someone else's change", updated_at: "external" };
    },
  };
}

test("body edits reread before saving and preserve other issue fields", async () => {
  const { backend, calls } = fixture();
  const target = address(source + "#body");
  const before = await backend.read(target, ".");
  await backend.save(target, before, "Changed\nLast line\n", ".");
  expect(calls.filter(([method]) => method === "PATCH")).toEqual([
    ["PATCH", "/repos/example/project/issues/12", { body: "Changed\nLast line\n" }],
  ]);
  expect((await backend.read(target, ".")).content).toBe("Changed\nLast line\n");
});

test("external changes refuse a stale edit without sending a mutation", async () => {
  const f = fixture();
  const target = address(source + "#body");
  const before = await f.backend.read(target, ".");
  f.external();
  await expect(f.backend.save(target, before, "Overwrite", ".")).rejects.toMatchObject({
    code: "GH_STALE_RESOURCE",
    effect: "not-applied",
  });
  expect(f.calls.some(([method]) => method === "PATCH")).toBe(false);
});

test("cards are read-only while body and typed fields expose different content", async () => {
  const { backend } = fixture();
  expect((await backend.read(address(source), ".")).editable).toBe(false);
  expect((await backend.read(address(source + "#body"), ".")).editable).toBe(true);
  const fields: unknown = JSON.parse(
    (await backend.read(address(source + "#fields"), ".")).content,
  );
  expect(fields).toMatchObject({ title: "Original", state: "open", labels: [] });
  expect(fields).not.toHaveProperty("updated_at");
});

test("unsupported actions and review submission do not silently dispatch", async () => {
  const { backend, calls } = fixture();
  await expect(
    backend.perform(address(source + "/merge"), "{}", ".", undefined, async () => false),
  ).rejects.toMatchObject({ effect: "not-applied" });
  await expect(
    backend.perform(
      address("github://example/project/pulls/12/reviews/3/submit"),
      '{"event":"APPROVE"}',
      ".",
      undefined,
      async () => false,
    ),
  ).rejects.toMatchObject({ code: "GH_APPROVAL_REQUIRED", effect: "not-applied" });
  expect(calls).toEqual([]);
});
