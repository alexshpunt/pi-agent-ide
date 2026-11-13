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

test("an anchor outside the result fails, names its range and changes nothing", async () => {
  const content = "keep\nOLD\nlast\n";
  const f = await fixture({ "task.txt": content });
  const read = await f.lines("task.txt", 2, 2);
  const outside = await f.run(replaceMutationTool, {
    path: read,
    start: lineAnchor("task.txt", content, 3),
    text: "BAD",
  });
  expect(outside.result.details.effect).toBe("not-applied");
  expect(outside.text).toContain("outside the result's selection: task.txt line 2");
  const exact = await f.run(replaceMutationTool, { path: read, start: "last", text: "BAD" });
  expect(exact.result.details.effect).toBe("not-applied");
  expect(exact.text).toContain("not found inside the selection");
  expect(exact.text).toContain("The result selects task.txt line 2.");
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
  const { result, text } = await f.run(deleteMutationTool, {
    path: both,
    start: lineAnchor("task.txt", content, 2),
    end: lineAnchor("task.txt", content, 4),
  });
  expect(result.details.effect).toBe("not-applied");
  expect(text).toContain("lie in different ranges");
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
  const { result, text } = await f.run(replaceMutationTool, {
    path: read,
    start: "KEY",
    text: "X",
  });
  expect(result.details.effect).toBe("not-applied");
  expect(text).toContain("matches in several files of the result");
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
