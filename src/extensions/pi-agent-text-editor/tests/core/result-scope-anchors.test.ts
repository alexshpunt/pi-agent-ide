import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import { createExactTextAnchorResolver } from "pi-agent-text-anchor-exact/api/anchor";
import { createLineHashAnchorResolver } from "pi-agent-text-anchor-line-hash/api/anchor";
import { textLineAnchors } from "pi-agent-text";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_POSITION_ANCHOR_KIND,
  TEXT_SEARCH_ANCHOR_KIND,
} from "#src/api/plugin-protocol.ts";
import { createTextEditorCore } from "#src/core/text-editor-core.ts";
import { createResultTargetAnchors } from "#src/core/result-target-anchors.ts";
import { createTextTool } from "#src/core/text-mutation.ts";
import { ToolCallInterceptionRenderStore } from "#src/core/tool-call-interceptor/rendering.ts";
import { copyMutationTool } from "#src/tools/tool-text-copy.ts";
import { deleteMutationTool } from "#src/tools/tool-text-delete.ts";
import { insertMutationTool } from "#src/tools/tool-text-insert.ts";
import { moveMutationTool } from "#src/tools/tool-text-move.ts";
import { replaceMutationTool } from "#src/tools/tool-text-replace.ts";
import type { TextMutationToolRegistration } from "#src/api/mutation-tool.ts";

const recovery = {
  fuzzyEnabled: false,
  threshold: 0.8,
  exactCandidateLimit: 20,
  fuzzyCandidateLimit: 5,
  maxFileSizeMiB: 20,
  maxQuerySizeKiB: 1024,
  seedLimit: 3,
  blockLineVariance: 2,
  contextLines: 15,
  timeoutMs: 2000,
};

let cwd = "";
/** The anchor Read shows before a line of a workspace file. */
const lineAnchor = (name: string, content: string, line: number) =>
  textLineAnchors(path.join(cwd, name), content)[line - 1];
beforeEach(async () => {
  const base = path.resolve(".tmp/result-scope-tests");
  await mkdir(base, { recursive: true });
  cwd = await mkdtemp(path.join(base, "workspace-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function fixture(files: Record<string, string>) {
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(cwd, name), content);
  const store = new ResultTargetStore();
  const core = createTextEditorCore();
  const tools = [
    replaceMutationTool,
    deleteMutationTool,
    insertMutationTool,
    copyMutationTool,
    moveMutationTool,
  ];
  for (const tool of tools) core.addMutationTool(tool);
  await core.registerPlugin({
    id: "result-scope-test",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addAnchorResolver(createResultTargetAnchors(store));
      api.addAnchorResolver({
        resolver: createLineHashAnchorResolver(),
        kind: TEXT_POSITION_ANCHOR_KIND,
        type: "major",
      });
      api.addAnchorResolver({
        resolver: createExactTextAnchorResolver(recovery),
        kind: TEXT_SEARCH_ANCHOR_KIND,
        type: "auxiliary",
        // Exact text handles what no other resolver claims, as in the IDE.
        priority: 10_000,
      });
      api.addResolver({
        resolver: {
          id: "workspace-file",
          async tryResolve(source) {
            const file = path.resolve(cwd, source);
            if (!(path.basename(file) in files)) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source: file,
                async read() {
                  return [{ type: "text", text: await readFile(file, "utf8") }];
                },
                async write(blocks) {
                  const block = blocks[0];
                  if (blocks.length !== 1 || block.type !== "text")
                    throw new Error("Expected text");
                  await writeFile(file, block.text);
                },
              },
            };
          },
        },
      });
    },
  });
  const annotations = new ToolCallInterceptionRenderStore();
  const tool = (registration: TextMutationToolRegistration) =>
    createTextTool(core, registration, annotations, () => undefined, store);
  /** Register a result that selects whole lines of a file, as a Read with offset/limit does. */
  const lines = async (name: string, first: number, last: number) => {
    const file = path.join(cwd, name);
    const content = await readFile(file, "utf8");
    return store.register(
      [
        {
          source: file,
          expectedContent: content,
          ranges: [
            {
              start: { lineNumber: first, column: 0 },
              end: { lineNumber: last + 1, column: 0 },
              linewise: true,
            },
          ],
        },
      ],
      cwd,
    );
  };
  const run = async (
    registration: TextMutationToolRegistration,
    input: Record<string, unknown>,
  ) => {
    const result = await tool(registration).execute("call", input, undefined, undefined, {
      cwd,
    } as ExtensionToolContext);
    return {
      result,
      text: result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
    };
  };
  const content = (name: string) => readFile(path.join(cwd, name), "utf8");
  return { store, run, lines, content };
}

test.each(["legacyCheckout", "legacy\u200bCheckout"])(
  "a multi-range result scopes its own selector and narrower selectors for %j",
  async (token) => {
    for (const selection of ["self", "all-lines", "narrower"] as const) {
      const original = `keep\nfirst ${token} suffix\ngap\nsecond ${token} suffix\nlast\n`;
      const f = await fixture({ "tokens.txt": original });
      const ranges = [2, 4].map((lineNumber, index) => ({
        start: { lineNumber, column: index === 0 ? 6 : 7 },
        end: { lineNumber, column: (index === 0 ? 6 : 7) + token.length },
      }));
      const register = (selected: typeof ranges) =>
        f.store.register(
          [{ source: path.join(cwd, "tokens.txt"), expectedContent: original, ranges: selected }],
          cwd,
        );
      const scope = register(ranges);
      const selector =
        selection === "self"
          ? scope
          : selection === "narrower"
            ? register(ranges.slice(1))
            : f.store.register(
                [
                  {
                    source: path.join(cwd, "tokens.txt"),
                    expectedContent: original,
                    ranges: [2, 4].map((lineNumber) => ({
                      start: { lineNumber, column: 0 },
                      end: { lineNumber: lineNumber + 1, column: 0 },
                      linewise: true,
                    })),
                  },
                ],
                cwd,
              );
      const { result, text } = await f.run(replaceMutationTool, {
        path: { id: scope },
        start: { id: selector },
        text: "NEW",
      });
      expect(result.details.effect, text).not.toBe("not-applied");
      expect(await f.content("tokens.txt")).toBe(
        selection === "all-lines"
          ? "keep\nNEW\ngap\nNEW\nlast\n"
          : selection === "narrower"
            ? `keep\nfirst ${token} suffix\ngap\nsecond NEW suffix\nlast\n`
            : "keep\nfirst NEW suffix\ngap\nsecond NEW suffix\nlast\n",
      );
    }
  },
);

test("a line anchor on a partial result line can move that line but cannot span a gap", async () => {
  const original = "keep\nfirst MATCH suffix\ngap\nsecond MATCH suffix\nlast\n";
  const f = await fixture({ "tokens.txt": original, "target.txt": "SLOT\n" });
  const scope = f.store.register(
    [
      {
        source: path.join(cwd, "tokens.txt"),
        expectedContent: original,
        ranges: [2, 4].map((lineNumber, index) => ({
          start: { lineNumber, column: index === 0 ? 6 : 7 },
          end: { lineNumber, column: index === 0 ? 11 : 12 },
        })),
      },
    ],
    cwd,
  );
  const first = lineAnchor("tokens.txt", original, 2);
  const acrossGap = await f.lines("tokens.txt", 2, 4);
  for (const selectors of [
    { start: first, end: lineAnchor("tokens.txt", original, 4) },
    { start: lineAnchor("tokens.txt", original, 3) },
    { start: "first", end: "first" },
    { start: { id: acrossGap } },
    { start: { id: scope }, end: first },
  ]) {
    const refused = await f.run(replaceMutationTool, {
      path: { id: scope },
      ...selectors,
      text: "BAD",
    });
    expect(refused.result.details.effect).toBe("not-applied");
    expect(await f.content("tokens.txt")).toBe(original);
  }
  const moved = await f.run(moveMutationTool, {
    path: { id: scope },
    start: first,
    end: first,
    target: "target.txt",
    targetStart: "SLOT",
    targetEnd: "SLOT",
  });
  expect(moved.result.details.effect, moved.text).not.toBe("not-applied");
  expect(await f.content("tokens.txt")).toBe("keep\ngap\nsecond MATCH suffix\nlast\n");
  expect(await f.content("target.txt")).toBe("first MATCH suffix\n");
});
function allMatchesReference(text: string): string {
  const reference = /SEARCH#[A-F\d]+:all:match/u.exec(text)?.[0];
  if (reference === undefined) throw new Error(`Expected an all-match reference in: ${text}`);
  return reference;
}

test.each([
  {
    title: "all matches beyond the candidate display limit, excluding a fuzzy decoy",
    content: "it's fine\n".repeat(23) + "it’s fine\n",
    query: "it's fine",
    expected: "done\n".repeat(23) + "it’s fine\n",
  },
  {
    title: "multiline matches normalized from CRLF, including the final line break",
    content: "a\r\nb\r\na\r\nb\r\n",
    query: "a\nb\n",
    expected: "done\r\ndone\r\n",
  },
  {
    title: "Unicode-tolerant literal matches with their original widths",
    content: "and…\nand…\n",
    query: "and...",
    expected: "done\ndone\n",
  },
])("Replace can retry $title", async ({ content, query, expected }) => {
  const f = await fixture({ "test.txt": content });
  const input = { path: "test.txt", start: query, text: query.endsWith("\n") ? "done\n" : "done" };
  const failed = await f.run(replaceMutationTool, input);
  expect(failed.result.details.effect).toBe("not-applied");
  expect(await f.content("test.txt")).toBe(content);

  expect(failed.result.details.anchorRecoveries?.[0]?.total).toBeGreaterThan(1);
  await f.run(replaceMutationTool, { ...input, start: allMatchesReference(failed.text) });
  expect(await f.content("test.txt")).toBe(expected);
});

test.each([
  { operation: deleteMutationTool, field: "start", expected: "outside red\n \n" },
  { operation: insertMutationTool, field: "anchor", expected: "outside red\n!red !red\n" },
])(
  "$operation.name retries only the matches inside the original scope",
  async ({ operation, field, expected }) => {
    const original = "outside red\nred red\n";
    const f = await fixture({ "test.txt": original });
    const input = {
      path: await f.lines("test.txt", 2, 2),
      [field]: "red",
      text: "!",
      before: true,
    };
    const failed = await f.run(operation, input);
    expect(failed.result.details.effect).toBe("not-applied");
    expect(await f.content("test.txt")).toBe(original);

    await f.run(operation, { ...input, [field]: allMatchesReference(failed.text) });
    expect(await f.content("test.txt")).toBe(expected);
  },
);

test.each([{ start: "aaa" }, { start: "red", end: "finish" }, { start: "finish", end: "red" }])(
  "Replace does not offer overlapping matches or a multi-range endpoint: %j",
  async (selectors) => {
    const content = "aaaaa\nred red finish\n";
    const f = await fixture({ "test.txt": content });
    const failed = await f.run(replaceMutationTool, {
      path: "test.txt",
      text: "done",
      ...selectors,
    });
    expect(failed.result.details.effect).toBe("not-applied");
    expect(failed.text).not.toMatch(/SEARCH#[A-F\d]+:all:match/u);
    expect(await f.content("test.txt")).toBe(content);
  },
);

test("an ambiguity retry changes each selected range without touching the gap between them", async () => {
  const original = "first red\ngap red\nthird red\n";
  const f = await fixture({ "test.txt": original });
  const scope = f.store.register(
    [
      {
        source: path.join(cwd, "test.txt"),
        expectedContent: original,
        ranges: [1, 3].map((lineNumber) => ({
          start: { lineNumber, column: 0 },
          end: { lineNumber: lineNumber + 1, column: 0 },
          linewise: true,
        })),
      },
    ],
    cwd,
  );
  const input = { path: scope, start: "red", text: "blue" };
  const failed = await f.run(replaceMutationTool, input);
  expect(failed.result.details.effect).toBe("not-applied");
  expect(await f.content("test.txt")).toBe(original);

  await f.run(replaceMutationTool, { ...input, start: allMatchesReference(failed.text) });
  expect(await f.content("test.txt")).toBe("first blue\ngap red\nthird blue\n");
});

test("an ambiguity reference neither adds later matches nor edits a changed selection", async () => {
  const original = "left red\nright red\n";
  const f = await fixture({ "test.txt": original, "changed.txt": original });
  const input = { start: "red", text: "blue" };
  const select = async (name: string) =>
    allMatchesReference((await f.run(replaceMutationTool, { path: name, ...input })).text);
  const fixed = await select("test.txt");
  const stale = await select("changed.txt");
  await writeFile(path.join(cwd, "test.txt"), original + "third red\n");
  const changed = "left red\nright green\n";
  await writeFile(path.join(cwd, "changed.txt"), changed);

  await f.run(replaceMutationTool, { path: "test.txt", ...input, start: fixed });
  expect(await f.content("test.txt")).toBe("left blue\nright blue\nthird red\n");
  const refused = await f.run(replaceMutationTool, {
    path: "changed.txt",
    ...input,
    start: stale,
  });
  expect(refused.result.details.effect).toBe("not-applied");
  expect(await f.content("changed.txt")).toBe(changed);
});

async function tokenFixture(complete = true) {
  const original = "red blue\n";
  const f = await fixture({ "tokens.txt": original, "target.txt": "left SLOT right\n" });
  const targets = [0, 4].map((column) => ({
    source: path.join(cwd, "tokens.txt"),
    expectedContent: original,
    ranges: [
      {
        start: { lineNumber: 1, column },
        end: { lineNumber: 1, column: column + (column === 0 ? 3 : 4) },
      },
    ],
  }));
  const whole = f.store.register(targets, cwd, complete, "Unsafe token union");
  const matches = targets.map((target) => f.store.register([target], cwd));
  return { ...f, whole, matches, original };
}

test.each([false, true])(
  "a guarded token result scopes an individual match (end: %s)",
  async (paired) => {
    const f = await tokenFixture();
    const { result, text } = await f.run(replaceMutationTool, {
      path: { id: f.whole },
      start: f.matches[0],
      ...(paired && { end: f.matches[0] }),
      text: "RED",
    });
    expect(result.details.effect, text).not.toBe("not-applied");
    expect(await f.content("tokens.txt")).toBe("RED blue\n");
  },
);

test.each([
  { tool: insertMutationTool, expected: "redNEW blue\n" },
  { tool: deleteMutationTool, expected: " blue\n" },
  { tool: copyMutationTool, expected: "red blue\n" },
  { tool: moveMutationTool, expected: " blue\n" },
])("$tool.name uses a guarded result only as its selector scope", async ({ tool, expected }) => {
  const f = await tokenFixture();
  const { result, text } = await f.run(tool, {
    path: { id: f.whole },
    ...(tool.name === "insert" ? { anchor: f.matches[0], text: "NEW" } : { start: f.matches[0] }),
    ...(["copy", "move"].includes(tool.name) && {
      target: "target.txt",
      targetStart: "SLOT",
      targetEnd: "SLOT",
    }),
  });
  expect(result.details.effect, text).not.toBe("not-applied");
  expect(await f.content("tokens.txt")).toBe(expected);
  expect(await f.content("target.txt")).toBe(
    ["copy", "move"].includes(tool.name) ? "left red right\n" : "left SLOT right\n",
  );
});

test.each(["ONE", "ONE\nextra"])(
  "a result scopes its surviving match after a sibling was replaced with %j",
  async (firstText) => {
    const original = "keep1\nOLD\nkeep2\nOLD\nkeep3\n";
    const f = await fixture({ "tokens.txt": original });
    const targets = [2, 4].map((lineNumber) => ({
      source: path.join(cwd, "tokens.txt"),
      expectedContent: original,
      ranges: [{ start: { lineNumber, column: 0 }, end: { lineNumber, column: 3 } }],
    }));
    const whole = f.store.register(targets, cwd, true, "Unsafe token union");
    const matches = targets.map((target) => f.store.register([target], cwd));
    const outside = await f.lines("tokens.txt", 1, 1);
    const first = await f.run(replaceMutationTool, {
      path: { id: whole },
      start: { id: matches[0] },
      text: firstText,
    });
    expect(first.result.details.effect).not.toBe("not-applied");
    const intermediate = `keep1\n${firstText}\nkeep2\nOLD\nkeep3\n`;
    expect(await f.content("tokens.txt")).toBe(intermediate);

    // A surviving range is scope authority only, never a silently shortened whole selection.
    expect(() => f.store.resolve(whole, cwd)).toThrow(Error);
    await expect(f.store.resolveCurrent(whole, cwd)).rejects.toThrow(Error);
    for (const input of [
      { path: { id: whole } },
      { path: matches },
      { path: { id: whole }, start: matches[0] },
      { path: { id: whole }, start: outside },
      { path: { id: whole }, start: "keep2" },
    ]) {
      const refused = await f.run(replaceMutationTool, { ...input, text: "BAD" });
      expect(refused.result.details.effect).toBe("not-applied");
      expect(await f.content("tokens.txt")).toBe(intermediate);
    }
    const second = await f.run(replaceMutationTool, {
      path: { id: whole },
      start: { id: matches[1] },
      end: { id: matches[1] },
      text: "TWO",
    });
    expect(second.result.details.effect, second.text).not.toBe("not-applied");
    const final = `keep1\n${firstText}\nkeep2\nTWO\nkeep3\n`;
    expect(await f.content("tokens.txt")).toBe(final);
    // Once every selected range was lost, the result cannot become a whole-file scope.
    const emptyScope = await f.run(replaceMutationTool, {
      path: { id: whole },
      start: "keep2",
      text: "BAD",
    });
    expect(emptyScope.result.details.effect).toBe("not-applied");
    expect(await f.content("tokens.txt")).toBe(final);
  },
);
test("a scope never rescues its stale individual match", async () => {
  const f = await tokenFixture();
  await f.run(replaceMutationTool, { path: f.matches[0], text: "RED" });
  const { result } = await f.run(replaceMutationTool, {
    path: { id: f.whole },
    start: f.matches[0],
    text: "BAD",
  });
  expect(result.details.effect).toBe("not-applied");
  expect(await f.content("tokens.txt")).toBe("RED blue\n");
});
test.each(["whole", "whole-anchor", "cross-range", "outside", "incomplete"])(
  "a guarded scope does not authorize %s edits",
  async (kind) => {
    const f = await tokenFixture(kind !== "incomplete");
    const { result } = await f.run(replaceMutationTool, {
      path: { id: f.whole },
      ...(kind !== "whole" && {
        start: kind === "whole-anchor" ? f.whole : kind === "outside" ? " " : f.matches[0],
      }),
      ...(kind === "cross-range" && { end: f.matches[1] }),
      text: "BAD",
    });
    expect(result.details.effect).toBe("not-applied");
    expect(await f.content("tokens.txt")).toBe(f.original);
  },
);
test.each([insertMutationTool, replaceMutationTool, deleteMutationTool])(
  "$name refuses selectors on multiple result inputs before writing any file",
  async (tool) => {
    for (const sameFile of [true, false]) {
      const original = "first\nmiddle\nlast\n";
      const f = await fixture({ "one.txt": original, "two.txt": original });
      const first = await f.lines("one.txt", 1, 1);
      const second = await f.lines(sameFile ? "one.txt" : "two.txt", 3, 3);
      for (const objectValues of [false, true]) {
        const selector = lineAnchor("one.txt", original, 1);
        const { result } = await f.run(tool, {
          path: objectValues ? [{ id: first }, { id: second }] : [first, second],
          ...(tool.name === "insert" ? { anchor: selector } : { start: selector, end: selector }),
          ...(tool.name === "delete" ? {} : { text: "CHANGED\n" }),
        });
        expect(result.details.effect).toBe("not-applied");
        expect(await f.content("one.txt")).toBe(original);
        expect(await f.content("two.txt")).toBe(original);
      }
    }
  },
);

test.each([
  { tool: insertMutationTool, expected: "first\nNEW\nmiddle\nlast\nNEW\n" },
  { tool: replaceMutationTool, expected: "NEW\nmiddle\nNEW\n" },
  { tool: deleteMutationTool, expected: "middle\n" },
])("$tool.name without selectors applies every result input", async ({ tool, expected }) => {
  const f = await fixture({ "one.txt": "first\nmiddle\nlast\n" });
  const first = await f.lines("one.txt", 1, 1);
  const last = await f.lines("one.txt", 3, 3);
  const { result } = await f.run(tool, {
    path: [first, last],
    ...(tool.name === "delete" ? {} : { text: "NEW\n" }),
  });
  expect(result.details.effect).not.toBe("not-applied");
  expect(await f.content("one.txt")).toBe(expected);
});

test("a single-element result list still scopes its selector", async () => {
  const original = "first\nmiddle\nlast\n";
  const f = await fixture({ "one.txt": original });
  const scope = await f.lines("one.txt", 1, 3);
  const { result } = await f.run(insertMutationTool, {
    path: [scope],
    anchor: lineAnchor("one.txt", original, 2),
    text: "NEW\n",
  });
  expect(result.details.effect).not.toBe("not-applied");
  expect(await f.content("one.txt")).toBe("first\nmiddle\nNEW\nlast\n");
});

test("a line anchor inside a Read result deletes that line", async () => {
  const f = await fixture({ "line.txt": "First\nLast\n" });
  const read = await f.lines("line.txt", 1, 2);
  const anchor = lineAnchor("line.txt", "First\nLast\n", 2);
  const { result } = await f.run(deleteMutationTool, { path: read, start: anchor });
  expect(result.details.effect).not.toBe("not-applied");
  expect(await f.content("line.txt")).toBe("First\n");
});

test("start and end anchors inside a result replace the span between them", async () => {
  const content = "keep\nalpha\nbeta\ngamma\nlast\n";
  const f = await fixture({ "task.txt": content });
  const read = await f.lines("task.txt", 2, 4);
  await f.run(replaceMutationTool, {
    path: read,
    start: lineAnchor("task.txt", content, 2),
    end: lineAnchor("task.txt", content, 3),
    text: "NEW\n",
  });
  expect(await f.content("task.txt")).toBe("keep\nNEW\ngamma\nlast\n");
});

test("a result stays a scope after an edit changed lines it selects", async () => {
  const content =
    "template <typename T>\nT one(T v) {\n  return v;\n}\ntemplate <typename T>\nT two(T v) {\n  return v;\n}\n";
  const f = await fixture({ "task.txt": content });
  const read = await f.lines("task.txt", 1, 8);
  await f.run(deleteMutationTool, {
    path: read,
    start: lineAnchor("task.txt", content, 1),
    end: lineAnchor("task.txt", content, 4),
  });
  // The same Read result, now covering changed lines, still scopes an anchor from that Read.
  const { result, text } = await f.run(deleteMutationTool, {
    path: read,
    start: lineAnchor("task.txt", content, 6),
  });
  expect(result.details.effect, text).not.toBe("not-applied");
  expect(await f.content("task.txt")).toBe("template <typename T>\n  return v;\n}\n");
});

test("exact text resolves inside the result even when it also occurs elsewhere", async () => {
  const f = await fixture({ "task.txt": "value = 1\nvalue = 2\nvalue = 3\n" });
  const read = await f.lines("task.txt", 2, 2);
  await f.run(replaceMutationTool, { path: read, start: "value", text: "other" });
  expect(await f.content("task.txt")).toBe("value = 1\nother = 2\nvalue = 3\n");
});

test.each([
  { content: "keep\nOLD\nlast\n", query: "last" },
  { content: "last\nOLD\nlast\n", query: "last" },
  { content: "keep\nOLD\nlast\n", query: "OLD\nlast" },
  { content: "\uFEFFkeep\r\nOLD\r\nlast\r\n", query: "last\r\n" },
])(
  "an exact selector that crosses or lies outside the selection fails: $query",
  async ({ content, query }) => {
    const f = await fixture({ "task.txt": content });
    const read = await f.lines("task.txt", 2, 2);
    const { result } = await f.run(replaceMutationTool, {
      path: read,
      start: query,
      text: "BAD",
    });
    expect(result.details.effect).toBe("not-applied");
    expect(result.details.results?.[0]?.errors[0]?.code).toBe("outside-scope");
    expect(await f.content("task.txt")).toBe(content);
  },
);

test.each(["absent", "\uFEFF"])(
  "an exact selector absent from the file fails: %s",
  async (query) => {
    const content = "keep\nOLD\nlast\n";
    const f = await fixture({ "task.txt": content });
    const read = await f.lines("task.txt", 2, 2);
    const { result } = await f.run(replaceMutationTool, {
      path: read,
      start: query,
      text: "BAD",
    });
    expect(result.details.effect).toBe("not-applied");
    expect(result.details.results?.[0]?.errors[0]?.code).toBe("missing");
    expect(await f.content("task.txt")).toBe(content);
  },
);
test("an anchor outside the result fails and changes nothing", async () => {
  const content = "keep\nOLD\nlast\n";
  const f = await fixture({ "task.txt": content });
  const read = await f.lines("task.txt", 2, 2);
  const outside = await f.run(replaceMutationTool, {
    path: read,
    start: lineAnchor("task.txt", content, 3),
    text: "BAD",
  });
  expect(outside.result.details.effect).toBe("not-applied");
  const exact = await f.run(replaceMutationTool, { path: read, start: "last", text: "BAD" });
  expect(exact.result.details.effect).toBe("not-applied");
  expect(await f.content("task.txt")).toBe(content);
});

test("anchors in two ranges of one result do not select the text between them", async () => {
  const content = "a\nOLD\nb\nOLD\nc\n";
  const f = await fixture({ "task.txt": content });
  const file = path.join(cwd, "task.txt");
  const both = f.store.register(
    [
      {
        source: file,
        expectedContent: content,
        ranges: [2, 4].map((line) => ({
          start: { lineNumber: line, column: 0 },
          end: { lineNumber: line, column: 3 },
        })),
      },
    ],
    cwd,
  );
  const { result } = await f.run(deleteMutationTool, {
    path: both,
    start: lineAnchor("task.txt", content, 2),
    end: lineAnchor("task.txt", content, 4),
  });
  expect(result.details.effect).toBe("not-applied");
  expect(await f.content("task.txt")).toBe(content);
});

test("insert places text at an anchor inside the result", async () => {
  const content = "one\ntwo\nthree\n";
  const f = await fixture({ "task.txt": content });
  const read = await f.lines("task.txt", 1, 3);
  await f.run(insertMutationTool, { path: read, anchor: "two", text: "ADDED\n" });
  expect(await f.content("task.txt")).toBe("one\ntwo\nADDED\nthree\n");
});

test("a result of several files edits the one file that holds the anchor", async () => {
  const f = await fixture({
    "sentence.txt": "left START old END right\n",
    "other.txt": "nothing here\n",
  });
  const sentence = path.join(cwd, "sentence.txt");
  const other = path.join(cwd, "other.txt");
  const whole = async (file: string) => {
    const text = await readFile(file, "utf8");
    return {
      source: file,
      expectedContent: text,
      ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 2, column: 0 } }],
    };
  };
  const read = f.store.register([await whole(sentence), await whole(other)], cwd);
  await f.run(replaceMutationTool, { path: read, start: "START", end: "END", text: "NEW" });
  expect(await f.content("sentence.txt")).toBe("left NEW right\n");
  expect(await f.content("other.txt")).toBe("nothing here\n");
});

test("text the selections of two files of a result both hold is ambiguous", async () => {
  const f = await fixture({ "one.txt": "KEY one\n", "two.txt": "KEY a\nKEY b\n" });
  const whole = async (name: string) => {
    const file = path.join(cwd, name);
    const text = await readFile(file, "utf8");
    const lines = text.split("\n").length;
    return {
      source: file,
      expectedContent: text,
      ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: lines, column: 0 } }],
    };
  };
  const read = f.store.register([await whole("one.txt"), await whole("two.txt")], cwd);
  const { result } = await f.run(replaceMutationTool, {
    path: read,
    start: "KEY",
    text: "X",
  });
  expect(result.details.effect).toBe("not-applied");
  expect(await f.content("one.txt")).toBe("KEY one\n");
});

test("copy uses a result as scope for its source and destination anchors", async () => {
  const f = await fixture({
    "source.txt": "COPY first\nCOPY second\n",
    "target.txt": "SLOT one\nSLOT two\n",
  });
  const source = await f.lines("source.txt", 2, 2);
  const target = await f.lines("target.txt", 2, 2);
  await f.run(copyMutationTool, {
    path: source,
    start: "COPY",
    target,
    targetStart: "SLOT",
    targetEnd: "SLOT",
  });
  expect(await f.content("target.txt")).toBe("SLOT one\nCOPY two\n");
  expect(await f.content("source.txt")).toBe("COPY first\nCOPY second\n");
});

test("move takes its source text by an anchor inside the result", async () => {
  const f = await fixture({
    "source.txt": "MOVE first\nMOVE second\n",
    "target.txt": "SLOT here\n",
  });
  const source = await f.lines("source.txt", 2, 2);
  const { result, text } = await f.run(moveMutationTool, {
    path: source,
    start: "MOVE",
    target: "target.txt",
    targetStart: "SLOT",
  });
  expect(result.details.effect, text).not.toBe("not-applied");
  expect(await f.content("source.txt")).toBe("MOVE first\n second\n");
  expect(await f.content("target.txt")).toBe("SLOTMOVE here\n");
});

test("a selector given as a value with an id selects that value's text", async () => {
  const content = "keep\nOLD\nlast\n";
  const f = await fixture({ "task.txt": content });
  const match = f.store.register(
    [
      {
        source: path.join(cwd, "task.txt"),
        expectedContent: content,
        ranges: [{ start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 3 } }],
      },
    ],
    cwd,
  );
  const { result, text } = await f.run(replaceMutationTool, {
    path: "task.txt",
    start: { id: match, text: "OLD" },
    text: "NEW",
  });
  expect(result.details.effect, text).not.toBe("not-applied");
  expect(await f.content("task.txt")).toBe("keep\nNEW\nlast\n");
});
