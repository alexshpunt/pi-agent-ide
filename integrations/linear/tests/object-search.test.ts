import { fixtureHost, required } from "./fixtures/check.ts";
import { expect, test } from "vitest";
import { encode } from "@toon-format/toon-v4";
import {
  createAxiObjectSearcher,
  parseResourceAddress,
  parseSearchAddress,
} from "#linear/object-search.ts";
import { createAuxiliaryReader, textFromRead } from "#linear/resource-read.ts";
import type { ReadPluginApi } from "pi-agent-ide/api/read";
const uuid = "71000000-0000-4000-8000-000000000006";
const input = {
  kind: "issues",
  workspace: "example",
  term: "body phrase",
  scope: "linear://example",
  limit: 2,
};
test("native adapter preserves exact continuation identity and never reads result bodies", async () => {
  const calls: readonly string[][] = [];
  let page = 0;
  const search = createAxiObjectSearcher(async (_cwd, args) => {
    (calls as string[][]).push([...args]);
    return encode({
      search: {
        kind: "issues",
        workspace: "example",
        term: "body phrase",
        items: [
          { id: "ENG-12", title: "Task", url: "https://linear.app/example/issue/ENG-12/task" },
        ],
        hasMore: page++ === 0,
        ...(page === 1 ? { cursor: "cursor/one" } : {}),
        totalCount: 3,
        postFiltered: false,
      },
    });
  });
  const first = await search(input, ".");
  expect(first.complete).toBe(false);
  expect(first.next).toBeTruthy();
  expect(parseSearchAddress(required(first.next))?.scope).toBe(input.scope);
  const second = await search({ ...input, scope: required(first.next) }, ".");
  expect(second.complete).toBe(true);
  expect(calls[1]).toContain("cursor/one");
  await expect(
    search({ ...input, term: "different", scope: required(first.next) }, "."),
  ).rejects.toThrow("LINEAR_IDENTITY_MISMATCH");
  expect(calls).toHaveLength(2);
});
test.each([
  `linear://example/project/${uuid}`,
  "https://linear.app/example/project/fixture-ab12cd34ef56",
])("project scope %s stays verified on every continuation page", async (scope) => {
  const projectUrl = "https://linear.app/example/project/fixture-ab12cd34ef56";
  const calls: string[][] = [];
  const search = createAxiObjectSearcher(async (_cwd, args) => {
    calls.push([...args]);
    if (args[0] === "resources" && args[1] === "scope")
      return encode({ project: { id: "P-ENG-1", uuid, url: projectUrl } });
    expect(args).toContain("--project-id");
    expect(args[args.indexOf("--project-id") + 1]).toBe(uuid);
    return encode({
      search: {
        kind: input.kind,
        workspace: input.workspace,
        term: input.term,
        items: [
          {
            id: "ENG-12",
            title: "Scoped task",
            url: "https://linear.app/example/issue/ENG-12/task",
          },
        ],
        hasMore: !args.includes("--cursor"),
        ...(!args.includes("--cursor") ? { cursor: "project/page" } : {}),
        totalCount: 2,
        postFiltered: false,
      },
    });
  });
  const first = await search({ ...input, scope }, ".");
  expect(first.items.map((item) => item.id)).toEqual(["ENG-12"]);
  expect(first.complete).toBe(false);
  expect(parseSearchAddress(required(first.next))?.scope).toBe(scope);
  const second = await search({ ...input, scope: required(first.next) }, ".");
  expect(second.complete).toBe(true);
  expect(calls[0]).toEqual([
    "resources",
    "scope",
    "project",
    scope.startsWith("linear:") ? uuid : "ab12cd34ef56",
    "--workspace",
    "example",
  ]);
  expect(calls[2]).toEqual(calls[0]);
  expect(calls[3]).toContain("project/page");
});

test("stable project discovery refuses a different project or workspace before searching", async () => {
  for (const project of [
    {
      id: "P-ENG-1",
      uuid: "00000000-0000-4000-8000-000000000000",
      url: "https://linear.app/example/project/fixture-ab12cd34ef56",
    },
    { id: "P-ENG-1", uuid, url: "https://linear.app/other/project/fixture-ab12cd34ef56" },
    { id: "P-ENG-1", uuid, url: "https://linear.app/example/team/ENG/overview" },
  ]) {
    const calls: string[][] = [];
    const search = createAxiObjectSearcher(async (_cwd, args) => {
      calls.push([...args]);
      return encode({ project });
    });
    await expect(
      search({ ...input, scope: `linear://example/project/${uuid}` }, "."),
    ).rejects.toThrow("LINEAR_IDENTITY_MISMATCH");
    expect(calls).toHaveLength(1);
  }
});

test.each([
  "linear://example/project/not-a-uuid",
  `linear://other/project/${uuid}`,
  `linear://example/project/${uuid}/description`,
  `linear://example/project/${uuid}/overview`,
  `linear://example/project/${uuid}#status`,
  `linear://example/project/${uuid}?query=ignored`,
  `linear://user:secret@example/project/${uuid}`,
  "https://linear.app/example/project/fixture-ab12cd34ef56#comments",
])("invalid project scope %s never falls back to workspace discovery", async (scope) => {
  let calls = 0;
  const search = createAxiObjectSearcher(async () => {
    calls++;
    throw new Error("Backend must not run");
  });
  await expect(search({ ...input, scope }, ".")).rejects.toThrow(
    /LINEAR_(INVALID_SEARCH_SCOPE|INVALID_URL)/,
  );
  expect(calls).toBe(0);
});
test("directory identities without native URLs are independently readable and explicitly not full-text", async () => {
  const search = createAxiObjectSearcher(async () =>
    encode({
      directory: {
        kind: "teams",
        workspace: "example",
        items: [{ id: uuid, title: "Engineering" }],
        hasMore: false,
        coverage: "API directory query, not full text.",
      },
    }),
  );
  const page = await search({ ...input, kind: "teams" }, ".");
  const address = required(parseResourceAddress(required(page.items[0]).url));
  expect(address.id).toBe(uuid);
  expect(page.notice).toContain("not full text");
  const read = createAuxiliaryReader(
    async () => {
      throw new Error("must not read linked resources");
    },
    async () =>
      encode({
        resource: {
          kind: "teams",
          workspace: "example",
          data: JSON.stringify({ id: uuid, name: "Engineering", description: "Full card text" }),
        },
      }),
  );
  expect(await read(address.source, ".")).toContain("Full card text");
});
test("directory cards retain their discovery query and cursor so a later page remains readable", async () => {
  const run = async (_cwd: string, args: readonly string[]) =>
    args[1] === "list"
      ? encode({
          directory: {
            kind: "labels",
            workspace: "example",
            items: [{ id: uuid, title: "bug" }],
            hasMore: false,
            coverage: "API name lookup.",
          },
        })
      : encode({
          resource: {
            kind: "labels",
            workspace: "example",
            data: JSON.stringify({ id: uuid, name: "bug" }),
          },
        });
  const search = createAxiObjectSearcher(run);
  const next = new URL("linear://example/search/labels");
  next.searchParams.set("q", "bug");
  next.searchParams.set("scope", "linear://example");
  next.searchParams.set("limit", "2");
  next.searchParams.set("cursor", "second-page");
  const page = await search({ ...input, kind: "labels", term: "bug", scope: next.href }, ".");
  const address = required(parseResourceAddress(required(page.items[0]).url));
  expect(address.query).toBe("bug");
  expect(address.cursor).toBe("second-page");
  const calls: readonly string[][] = [];
  const read = createAuxiliaryReader(
    async () => {
      throw new Error("not used");
    },
    async (cwd, args) => {
      (calls as string[][]).push([...args]);
      return run(cwd, args);
    },
  );
  expect(await read(address.source, ".")).toContain("bug");
  expect(calls[0]).toContain("second-page");
  expect(calls[0]).toContain("bug");
});

test("native adapter refuses malformed or foreign identities and repeated or missing continuation", async () => {
  for (const patch of [
    { workspace: "other" },
    { items: [{ id: "ENG-12", title: "Task", url: "https://evil.test/issue/ENG-12" }] },
    { hasMore: true },
  ]) {
    const search = createAxiObjectSearcher(async () =>
      encode({
        search: {
          kind: "issues",
          workspace: "example",
          term: input.term,
          items: [],
          hasMore: false,
          totalCount: 0,
          postFiltered: false,
          ...patch,
        },
      }),
    );
    await expect(search(input, ".")).rejects.toThrow(/LINEAR_(IDENTITY_MISMATCH|INVALID_RESPONSE)/);
  }
});
test("Read bridge uses complete script text, not preview lines; non-text and partial sources fail", async () => {
  let request: unknown;
  let audience: unknown;
  const api = {
    read: async (req, _context, target) => {
      request = req;
      audience = target;
      return {
        content: [{ type: "text", text: "Preview only" }],
        details: { source: required(req.path) },
        script: {
          kind: "text",
          source: required(req.path),
          content: "Full body",
          lines: [],
          startLine: 1,
          endLine: 20,
          totalLines: 20,
        },
      };
    },
  } satisfies Pick<ReadPluginApi, "read">;
  const snapshot = await textFromRead(() => fixtureHost<ReadPluginApi>(api))(
    "linear://example/document/" + uuid,
    ".",
  );
  expect(snapshot.content).toBe("Full body");
  expect(audience).toBe("script");
  expect(request).toEqual({ path: "linear://example/document/" + uuid });
  const incomplete: NonNullable<Awaited<ReturnType<ReadPluginApi["read"]>>["script"]>[] = [
    { kind: "native", source: "source", blocks: [] },
    {
      kind: "text",
      source: "source",
      content: "Partial",
      lines: [],
      startLine: 1,
      endLine: 1,
      totalLines: 20,
    },
  ];
  for (const script of incomplete) {
    await expect(
      textFromRead(() =>
        fixtureHost<ReadPluginApi>({
          read: async () => ({ content: [], details: { source: "source" }, script }),
        }),
      )("source", "."),
    ).rejects.toThrow("LINEAR_NON_TEXT_RESOURCE");
  }
});
test("attachment reads delegate only the returned URL to its provider, not AXI credentials or other links", async () => {
  const reads: string[] = [];
  const read = createAuxiliaryReader(
    async (source) => {
      reads.push(source);
      return { source, content: "Attachment body", complete: true };
    },
    async () =>
      encode({
        resource: {
          kind: "attachments",
          workspace: "example",
          data: JSON.stringify({
            url: "https://example.org/file.txt",
            other: "https://example.org/ignored",
          }),
        },
      }),
  );
  expect(await read("linear://example/resource/attachments/" + uuid, ".")).toBe("Attachment body");
  expect(reads).toEqual(["https://example.org/file.txt"]);
});

test("parent issue discovery uses direct-child filtering and keeps the parent in continuation", async () => {
  const parentId = "11111111-1111-4111-8111-111111111111";
  const parent = "https://linear.app/example/issue/ENG-12/parent";
  const calls: string[][] = [];
  let page = 0;
  const search = createAxiObjectSearcher(async (_cwd, args) => {
    calls.push([...args]);
    if (args[1] === "view")
      return encode({
        issue: { id: "ENG-12", uuid: parentId, title: "Parent", url: parent, description: "" },
      });
    return encode({
      search: {
        workspace: "example",
        kind: "issues",
        term: "body phrase",
        parentId,
        items: [
          {
            id: "ENG-13",
            title: "Matching child",
            url: "https://linear.app/example/issue/ENG-13/child",
          },
        ],
        hasMore: page++ === 0,
        ...(page === 1 ? { cursor: "next/child" } : {}),
        totalCount: 2,
      },
    });
  });
  const first = await search({ ...input, scope: parent }, ".");
  expect(first.items.map((item) => item.id)).toEqual(["ENG-13"]);
  expect(first.notice).toContain("Native full-text");
  expect(calls[1]).toContain("--parent-id");
  expect(calls[1]).toContain(parentId);
  expect(calls[1]).toContain("body phrase");
  const next = parseSearchAddress(required(first.next));
  expect(next?.scope).toBe(parent);
  const second = await search({ ...input, scope: required(first.next) }, ".");
  expect(second.complete).toBe(true);
  expect(calls[3]).toContain("next/child");
  await expect(search({ ...input, kind: "projects", scope: parent }, ".")).rejects.toThrow(
    "LINEAR_INVALID_SEARCH_SCOPE",
  );
});

test("a collection fragment is not silently accepted as a different object-search scope", async () => {
  const run = async () => {
    throw new Error("must not call backend");
  };
  const search = createAxiObjectSearcher(run);
  await expect(
    search({ ...input, scope: "https://linear.app/example/issue/ENG-12/parent#comments" }, "."),
  ).rejects.toThrow("LINEAR_INVALID_SEARCH_SCOPE");
});
