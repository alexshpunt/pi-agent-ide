import { required } from "./fixtures/check.ts";
import { expect, test, vi } from "vitest";
import { createLinearSearchResolver } from "#linear/search.ts";

const issue = "https://linear.app/example/issue/ENG-12/a-task";
const project = "https://linear.app/example/project/fixture-ab12cd34ef56/overview";
const context = { cwd: "/workspace" };
const body =
  "# ENG-12: A task\n\nSSH first\nssh second\nAn attachment: https://example.org/a-document\n";
function fixture() {
  const searchObjects = vi.fn().mockResolvedValue({
    kind: "issues",
    workspace: "example",
    term: "SSH",
    items: [{ id: "ENG-12", title: "A task", url: issue }],
    complete: false,
    next: "linear://example/search/issues?term=SSH&cursor=next",
  });
  const readText = vi.fn().mockResolvedValue({ source: issue, content: body });
  return { searchObjects, readText, resolver: createLinearSearchResolver(searchObjects, readText) };
}

test.each([project, "linear://example/project/71000000-0000-4000-8000-000000000006"])(
  "native discovery forwards its kind, term, workspace and selected project scope %s",
  async (project) => {
    const { resolver, searchObjects, readText } = fixture();
    const result = await resolver.tryResolve(
      { query: "linear:issues SSH", path: project, limit: 25 },
      context,
    );
    expect(result.kind).toBe("resolved");
    expect(searchObjects).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "issues",
        term: "SSH",
        workspace: "example",
        scope: project,
        limit: 25,
      }),
      context.cwd,
      undefined,
    );
    expect(readText).not.toHaveBeenCalled();
    if (result.kind !== "resolved") throw new Error("Missing result");
    const formatted = await resolver.format(result.payload, context);
    expect(
      formatted.content.some((block) => block.type === "text" && block.text.includes(issue)),
    ).toBe(true);
    expect(resolver.toScriptData?.(result.payload, formatted.details)).toMatchObject({
      kind: "custom",
      resolverId: "linear",
      value: { items: [{ url: issue }], complete: false },
    });
  },
);

test("searching a selected card matches its text without following its attachment links", async () => {
  const { resolver, readText, searchObjects } = fixture();
  const result = await resolver.tryResolve({ query: "SSH", path: issue }, context);
  expect(searchObjects).not.toHaveBeenCalled();
  expect(readText).toHaveBeenCalledTimes(1);
  expect(readText).toHaveBeenCalledWith(issue, context.cwd, undefined);
  if (result.kind !== "resolved") throw new Error("Missing matches");
  const formatted = await resolver.format(result.payload, context);
  expect(resolver.toScriptData?.(result.payload, formatted.details)).toMatchObject({
    kind: "matches",
    complete: true,
    matches: [
      { source: issue, range: { startLine: 3, startColumn: 0, endLine: 3, endColumn: 3 } },
      { source: issue, range: { startLine: 4, startColumn: 0, endLine: 4, endColumn: 3 } },
    ],
  });
  const absent = await resolver.tryResolve({ query: "absent", path: issue }, context);
  if (absent.kind !== "resolved") throw new Error("Missing empty result");
  expect(resolver.toScriptData?.(absent.payload, undefined)).toMatchObject({
    kind: "matches",
    complete: true,
    matches: [],
  });
});

test("case, whole-word, regex and output limits are respected for selected text", async () => {
  const { resolver, readText } = fixture();
  readText.mockResolvedValue({ source: issue, content: "SSH SSHing ssh\n" });
  for (const [request, expected, complete] of [
    [{ query: "SSH", caseSensitive: true, wholeWord: true }, 1, true],
    [{ query: "regex:ssh(?:ing)?" }, 3, true],
    [{ query: "SSH", limit: 1 }, 1, false],
  ] as const) {
    const result = await resolver.tryResolve({ ...request, path: issue }, context);
    if (result.kind !== "resolved") throw new Error("Missing matches");
    const data = resolver.toScriptData?.(result.payload, undefined) as {
      complete: boolean;
      matches: unknown[];
    };
    expect(data.matches).toHaveLength(expected);
    expect(data.complete).toBe(complete);
  }
});

test("exact result scopes never search outside selected ranges and reject changed source text", async () => {
  const { resolver, readText } = fixture();
  const scoped = {
    ...context,
    scope: {
      complete: true,
      targets: [
        {
          source: issue,
          expectedContent: body,
          ranges: [{ start: { lineNumber: 4, column: 0 }, end: { lineNumber: 4, column: 10 } }],
        },
      ],
    },
  };
  const result = await resolver.tryResolve({ query: "SSH" }, scoped);
  if (result.kind !== "resolved") throw new Error("Missing scoped matches");
  expect(resolver.toScriptData?.(result.payload, undefined)).toMatchObject({
    complete: true,
    matches: [{ range: { startLine: 4 } }],
  });
  readText.mockResolvedValue({ source: issue, content: body + "changed" });
  const stale = await resolver.tryResolve({ query: "SSH" }, scoped);
  expect(stale.kind).toBe("failed");
  if (stale.kind !== "failed") throw new Error("Expected stale selection failure");
  expect(String(stale.error)).toContain("LINEAR_SCOPE_STALE");
});

test("unrelated local and web queries are not claimed; native queries require an explicit workspace", async () => {
  const { resolver, searchObjects, readText } = fixture();
  expect(await resolver.tryResolve({ query: "SSH", path: "src" }, context)).toEqual({
    kind: "not-handled",
  });
  expect(
    await resolver.tryResolve({ query: "SSH", path: "https://example.org/page" }, context),
  ).toEqual({ kind: "not-handled" });
  expect(await resolver.tryResolve({ query: "linear:issues SSH" }, context)).toMatchObject({
    kind: "failed",
  });
  expect(searchObjects).not.toHaveBeenCalled();
  expect(readText).not.toHaveBeenCalled();
});

test("a shared live selection is projected to serializable data without session readers", async () => {
  const resolver = createLinearSearchResolver(
    async () => {
      throw new Error("not used");
    },
    async (source) => ({ source, content: "SSH", complete: true }),
    async (selection) => ({
      ...selection,
      id: "ABCD",
      target: "RESULT#fixture",
      matchTargets: ["RESULT#match"],
      read: () => Promise.resolve("private session state"),
    }),
  );
  const result = await resolver.tryResolve({ query: "SSH", path: issue }, context);
  expect(result.kind).toBe("resolved");
  if (result.kind === "resolved") {
    expect(() => structuredClone(result.payload)).not.toThrow();
    expect(required(resolver.toScriptData)(result.payload, undefined)).toMatchObject({
      target: "RESULT#fixture",
      matches: [{ references: { match: "SEARCH#ABCD:1:match" } }],
    });
    expect(JSON.stringify(result.payload)).not.toContain("private session state");
  }
});

test("safe backend failures and cancellation are visible, never empty results", async () => {
  const { resolver, searchObjects, readText } = fixture();
  searchObjects.mockRejectedValue(new Error("Authorization: Bearer private-token"));
  const result = await resolver.tryResolve(
    { query: "linear:issues SSH", path: "linear://example" },
    context,
  );
  expect(result.kind).toBe("failed");
  expect(JSON.stringify(result)).not.toContain("private-token");
  readText.mockRejectedValue(new Error("LINEAR_CONTENT_UNAVAILABLE"));
  expect(await resolver.tryResolve({ query: "SSH", path: issue }, context)).toMatchObject({
    kind: "failed",
  });
  const abort = new AbortController();
  abort.abort();
  await expect(
    resolver.tryResolve({ query: "SSH", path: issue }, { ...context, signal: abort.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("subtask discovery and discussion text search remain distinct operations", async () => {
  const { resolver, searchObjects, readText } = fixture();
  const children = await resolver.tryResolve(
    { query: "linear:issues SSH", path: issue + "#subtasks", limit: 2 },
    context,
  );
  expect(children.kind).toBe("resolved");
  expect(searchObjects).toHaveBeenCalledWith(
    expect.objectContaining({ scope: issue + "#subtasks", kind: "issues" }),
    context.cwd,
    undefined,
  );
  expect(readText).not.toHaveBeenCalled();
  searchObjects.mockClear();
  const discussion = issue + "#comments";
  readText.mockResolvedValue({
    source: discussion,
    content: "Comments\nSSH only in a comment",
    complete: false,
  });
  const matches = await resolver.tryResolve({ query: "SSH", path: discussion }, context);
  expect(searchObjects).not.toHaveBeenCalled();
  expect(readText).toHaveBeenCalledWith(discussion, context.cwd, undefined);
  if (matches.kind !== "resolved") throw new Error("Missing discussion matches");
  expect(resolver.toScriptData?.(matches.payload, undefined)).toMatchObject({
    complete: false,
    matches: [{ source: discussion, range: { startLine: 2 } }],
  });
});
