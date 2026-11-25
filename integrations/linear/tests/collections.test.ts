import { jsonRecord, required } from "./fixtures/check.ts";
import { readFile } from "node:fs/promises";
import { encode } from "@toon-format/toon-v4";
import { expect, test, vi } from "vitest";
import {
  createAxiCollectionReader,
  createAxiCommentReader,
  parseLinearCollectionAddress,
} from "#linear/collections.ts";

const parentId = "11111111-1111-4111-8111-111111111111";
const commentId = "22222222-2222-4222-8222-222222222222";
const docId = "33333333-3333-4333-8333-333333333333";
const issue = "https://linear.app/example/issue/ENG-12/a-task";
const issueView = encode({
  issue: { id: "ENG-12", uuid: parentId, title: "Parent", url: issue, description: "Parent only" },
});

function issueRun(comments: unknown) {
  return vi.fn(async (_cwd: string, args: readonly string[]) => {
    if (args[0] === "issues" && args[1] === "view") return issueView;
    if (args[0] === "comments") return encode({ count: "1", comments });
    throw new Error("Unexpected operation");
  });
}

test("collection fragments preserve parent and continuation identity for native and stable URLs", () => {
  const addresses = [
    issue + "#comments",
    "linear://example/issue/ENG-12#subtasks",
    "linear://example/document/" + docId + "?cursor=next%2Fpage#comments",
    "https://linear.app/example/project/fixture-ab12cd34ef56/overview#comments",
  ];
  for (const source of addresses)
    expect(parseLinearCollectionAddress(source)?.source).toBe(new URL(source).href);
  expect(parseLinearCollectionAddress(issue + "#description")).toBeUndefined();
  expect(parseLinearCollectionAddress("https://example.org/page#comments")).toBeUndefined();
  expect(parseLinearCollectionAddress("https://linear.app/docs/mcp#comments")).toBeUndefined();
  for (const source of [
    "linear://example/document/" + docId + "#subtasks",
    issue + "?cursor=first&cursor=second#comments",
    "linear://user:secret@example/issue/ENG-12#comments",
    issue + "?unknown=value#comments",
  ])
    expect(() => parseLinearCollectionAddress(source)).toThrow("LINEAR_INVALID_URL");
});

test("discussion reads preserve complete Unicode bodies and individual links without following them", async () => {
  const run = issueRun([
    {
      id: commentId,
      body: "Первая строка\n\nSecond line with [link](https://example.org/file)",
      user: { name: "Author" },
      createdAt: "2026-10-10T07:00:00Z",
    },
  ]);
  const result = await createAxiCollectionReader(run)(issue + "#comments", ".");
  expect(result.content).toContain("Первая строка\n\nSecond line");
  expect(result.content).toContain("linear://example/issue/ENG-12/comment/" + commentId);
  expect(result.content).toContain("Author");
  expect(result.complete).toBe(true);
  expect(run).toHaveBeenCalledTimes(2);
  expect(required(run.mock.calls[1])[1]).toContain("--full");
});

test("nested full discussion pages retain their exact cursor and incomplete coverage", async () => {
  const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
    if (args[0] === "issues") return issueView;
    return encode({
      comments: {
        comments: [{ id: commentId, body: "A comment" }],
        hasNextPage: !args.includes("--cursor"),
        ...(args.includes("--cursor") ? {} : { endCursor: "next/page" }),
      },
    });
  });
  const read = createAxiCollectionReader(run);
  const first = await read(issue + "#comments", ".");
  expect(first.complete).toBe(false);
  const next = /Next page: <([^>]+)>/u.exec(first.content)?.[1];
  expect(next).toBeTruthy();
  expect(parseLinearCollectionAddress(required(next))?.cursor).toBe("next/page");
  await read(required(next), ".");
  expect(required(run.mock.calls[3])[1]).toContain("next/page");
  for (const comments of [
    { comments: [], hasNextPage: true },
    { comments: [], hasNextPage: true, endCursor: "next/page" },
  ]) {
    const bad = createAxiCollectionReader(issueRun(comments));
    const source = comments.endCursor ? required(next) : issue + "#comments";
    await expect(bad(source, ".")).rejects.toThrow(
      comments.endCursor ? "LINEAR_INVALID_RESPONSE" : "LINEAR_LOOKUP_INCOMPLETE",
    );
  }
});

test("empty discussions differ from inaccessible or malformed responses", async () => {
  const empty = await createAxiCollectionReader(issueRun([]))(issue + "#comments", ".");
  expect(empty.content).toContain("Comments (0)");
  expect(empty.complete).toBe(true);
  const denied = issueRun([]);
  denied.mockImplementation(async () => {
    throw new Error("LINEAR_AUTH_REQUIRED");
  });
  await expect(createAxiCollectionReader(denied)(issue + "#comments", ".")).rejects.toThrow(
    "LINEAR_AUTH_REQUIRED",
  );
  await expect(
    createAxiCollectionReader(issueRun([{ id: commentId }]))(issue + "#comments", "."),
  ).rejects.toThrow("LINEAR_INVALID_RESPONSE");
});

test("wrong parent workspace refuses before listing its comments", async () => {
  const run = vi.fn(async () =>
    encode({
      issue: {
        id: "ENG-12",
        uuid: parentId,
        title: "Parent",
        url: issue.replace("example", "other"),
        description: "",
      },
    }),
  );
  await expect(createAxiCollectionReader(run)(issue + "#comments", ".")).rejects.toThrow(
    "LINEAR_IDENTITY_MISMATCH",
  );
  expect(run).toHaveBeenCalledTimes(1);
});

test("project and document discussions use the verified parent UUID through the read-only backend", async () => {
  for (const parentKind of ["project", "document"] as const) {
    let input: Record<string, unknown> | undefined;
    const native =
      parentKind === "document"
        ? "https://linear.app/example/document/fixture-ab12cd34ef56"
        : "https://linear.app/example/project/fixture-ab12cd34ef56/overview";
    const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
      if (args[0] === "resources") {
        input = jsonRecord(await readFile(required(args.at(-1)), "utf8"));
        return encode({
          invocation: {
            workspace: "example",
            operation: "list_comments",
            effect: "applied",
            data: JSON.stringify({
              comments: [{ id: commentId, body: "Full discussion body" }],
              hasNextPage: false,
            }),
          },
        });
      }
      return encode({
        [parentKind]: {
          id: docId,
          uuid: docId,
          title: "Document",
          name: "Project",
          url: native,
          content: "",
          description: "",
        },
      });
    });
    const result = await createAxiCollectionReader(run)(native + "#comments", ".");
    expect(result.content).toContain("Full discussion body");
    expect(input).toEqual({ [parentKind + "Id"]: docId, limit: 50, orderBy: "createdAt" });
    expect(run).toHaveBeenCalledTimes(2);
  }
});

test("direct children require the verified parent rather than merely matching text", async () => {
  const run = vi.fn(async (_cwd: string, args: readonly string[]) =>
    args[1] === "view"
      ? issueView
      : encode({
          children: {
            workspace: "example",
            parentId,
            hasMore: false,
            items: [
              {
                id: "ENG-13",
                title: "Child",
                url: "https://linear.app/example/issue/ENG-13/child",
                parentId,
              },
            ],
          },
        }),
  );
  const read = createAxiCollectionReader(run);
  const result = await read(issue + "#subtasks", ".");
  expect(result.content).toContain("ENG-13");
  expect(required(run.mock.calls[1])[1]).toContain("--parent-id");
  expect(required(run.mock.calls[1])[1]).toContain("children");
  for (const row of [
    {
      id: "ENG-13",
      title: "Outside",
      url: "https://linear.app/example/issue/ENG-13/child",
      parentId: docId,
    },
    {
      id: "ENG-13",
      title: "Outside workspace",
      url: "https://linear.app/other/issue/ENG-13/child",
      parentId,
    },
    { id: "ENG-13", title: "Missing parent", url: "https://linear.app/example/issue/ENG-13/child" },
  ]) {
    const bad = async (_cwd: string, args: readonly string[]) =>
      args[1] === "view"
        ? issueView
        : encode({ children: { workspace: "example", parentId, items: [row], hasMore: false } });
    await expect(createAxiCollectionReader(bad)(issue + "#subtasks", ".")).rejects.toThrow(
      /LINEAR_(IDENTITY_MISMATCH|INVALID_RESPONSE)/u,
    );
  }
});

test("individual document comments follow bounded pages without reading other linked resources", async () => {
  let page = 0;
  const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
    if (args[0] === "documents")
      return encode({
        document: {
          id: docId,
          title: "Document",
          url: "https://linear.app/example/document/fixture-ab12cd34ef56",
          content: "",
        },
      });
    return encode({
      invocation: {
        workspace: "example",
        operation: "list_comments",
        effect: "applied",
        data: JSON.stringify(
          page++ === 0
            ? { comments: [], hasNextPage: true, endCursor: "next" }
            : { comments: [{ id: commentId, body: "Found full body" }], hasNextPage: false },
        ),
      },
    });
  });
  const result = await createAxiCommentReader(run)(
    "linear://example/document/" + docId + "/comment/" + commentId,
    ".",
  );
  expect(result.content).toBe("Found full body");
  expect(run).toHaveBeenCalledTimes(3);
});

test("an issue comment lookup checks the parent and lists comments at the same time", async () => {
  const started: string[] = [];
  let release!: () => void;
  const parentChecked = new Promise<void>((resolve) => (release = resolve));
  const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
    started.push(`${args[0]} ${args[1]}`);
    if (args[0] === "issues") {
      // The parent check finishes only after the list request has started.
      await parentChecked;
      return issueView;
    }
    release();
    return encode({ count: "1", comments: [{ id: commentId, body: "Parallel body" }] });
  });
  const result = await createAxiCommentReader(run)(
    "linear://example/issue/ENG-12/comment/" + commentId,
    ".",
  );
  expect(result.content).toBe("Parallel body");
  expect(started.sort()).toEqual(["comments list", "issues view"]);
});

test("a failed parent check takes precedence over the comment list", async () => {
  const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
    if (args[0] === "issues") throw new Error("LINEAR_NOT_FOUND");
    throw new Error("LINEAR_INVALID_RESPONSE");
  });
  await expect(
    createAxiCommentReader(run)("linear://example/issue/ENG-12/comment/" + commentId, "."),
  ).rejects.toThrow("LINEAR_NOT_FOUND");
});

test("zero filtered rows with a backend more-pages flag cannot establish absence without a cursor", async () => {
  const run = async (_cwd: string, args: readonly string[]) =>
    args[1] === "view"
      ? issueView
      : encode({ children: { workspace: "example", parentId, items: [], hasMore: true } });
  await expect(createAxiCollectionReader(run)(issue + "#subtasks", ".")).rejects.toThrow(
    "LINEAR_INVALID_RESPONSE",
  );
});

test("discussion bodies remain usable when an author has been removed", async () => {
  const run = issueRun([{ id: commentId, body: "Retained body", user: null }]);
  expect((await createAxiCollectionReader(run)(issue + "#comments", ".")).content).toContain(
    "Retained body",
  );
});
