import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
beforeEach(async () => {
  const base = path.resolve(".tmp/ambiguous-candidates-tests");
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
  for (const tool of [
    replaceMutationTool,
    deleteMutationTool,
    insertMutationTool,
    copyMutationTool,
    moveMutationTool,
  ])
    core.addMutationTool(tool);
  await core.registerPlugin({
    id: "ambiguous-candidates-test",
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
  const run = async (
    registration: TextMutationToolRegistration,
    input: Record<string, unknown>,
  ) => {
    const tool = createTextTool(core, registration, annotations, () => undefined, store);
    const result = await tool.execute("call", input, undefined, undefined, {
      cwd,
    } as ExtensionToolContext);
    return {
      result,
      text: result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
    };
  };
  const content = (name: string) => readFile(path.join(cwd, name), "utf8");
  return { run, content };
}

/** The anchor Read shows before a line of a file. */
const anchorOf = (content: string, line: number) =>
  requiredAnchor(textLineAnchors("any", content)[line - 1]);
function requiredAnchor(anchor: string | undefined): string {
  if (anchor === undefined) throw new Error("No such line");
  return anchor;
}
const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

const cpp = lines(
  "// SLOT_1", // 1
  "", // 2
  "inline size_t getSize(const prop& p) {", // 3
  "  switch (p.type) {", // 4
  "    case 1: return 1;", // 5
  "  }", // 6: nested closing brace
  "  return 0;", // 7
  "}", // 8: the function's own closing brace
  "template <typename T>", // 9
  "inline bool other() {", // 10
  "  if (x) {", // 11
  "    y();", // 12
  "  }", // 13
  "  return false;", // 14
  "}", // 15
);

describe("a second boundary must match once after the first (LPT-1773)", () => {
  test("move from a function signature through a bare closing brace is refused, not cut short", async () => {
    const f = await fixture({ "main.cpp": cpp });
    const input = {
      path: "main.cpp",
      from: "inline size_t getSize(const prop& p) {",
      through: "}",
      target: "main.cpp",
      targetAt: "// SLOT_1",
    };
    const refused = await f.run(moveMutationTool, input);
    expect(refused.result.details.effect).toBe("not-applied");
    expect(await f.content("main.cpp")).toBe(cpp);
    // Every closing brace after the signature is a candidate, nearest first.
    expect(refused.result.details.anchorRecoveries?.[0]?.total).toBe(4);
    const text = refused.text;
    for (const line of [6, 8, 13, 15]) {
      expect(text).toContain(`line ${line}`);
      expect(text).toContain(anchorOf(cpp, line));
    }
    expect(text.indexOf(`line 6`)).toBeLessThan(text.indexOf(`line 8`));

    // The function's own closing line, picked from the list, moves the whole function.
    const moved = await f.run(moveMutationTool, { ...input, through: anchorOf(cpp, 8) });
    expect(moved.result.details.effect).not.toBe("not-applied");
    expect(await f.content("main.cpp")).toBe(
      lines(
        "inline size_t getSize(const prop& p) {",
        "  switch (p.type) {",
        "    case 1: return 1;",
        "  }",
        "  return 0;",
        "}",
        "",
        "template <typename T>",
        "inline bool other() {",
        "  if (x) {",
        "    y();",
        "  }",
        "  return false;",
        "}",
      ),
    );
  });

  const spec = lines(
    'describe("x", () => {', // 1
    '  test("a", () => {', // 2
    "    expect(a).toBe(1);", // 3
    "  });", // 4
    '  test("b", () => {', // 5
    "    expect(b).toBe(2);", // 6
    "  });", // 7
    '  test("c", () => {', // 8
    "    expect(c).toBe(3);", // 9
    "  });", // 10
    "});", // 11
  );

  test("delete from a test line through a call close with later tests is refused", async () => {
    const f = await fixture({ "x.test.ts": spec });
    const input = { path: "x.test.ts", from: '  test("a", () => {', through: "});" };
    const refused = await f.run(deleteMutationTool, input);
    expect(refused.result.details.effect).toBe("not-applied");
    expect(await f.content("x.test.ts")).toBe(spec);
    expect(refused.result.details.anchorRecoveries?.[0]?.total).toBe(4);
    const deleted = await f.run(deleteMutationTool, { ...input, through: anchorOf(spec, 4) });
    expect(deleted.result.details.effect).not.toBe("not-applied");
    expect(await f.content("x.test.ts")).toBe(
      lines(
        'describe("x", () => {',
        '  test("b", () => {',
        "    expect(b).toBe(2);",
        "  });",
        '  test("c", () => {',
        "    expect(c).toBe(3);",
        "  });",
        "});",
      ),
    );
  });

  test("matches before the first boundary do not count", async () => {
    const source = lines("END early", "END again", "BEGIN here", "tail END", "after");
    const f = await fixture({ "t.txt": source });
    const done = await f.run(replaceMutationTool, {
      path: "t.txt",
      from: "BEGIN",
      through: "END",
      text: "NEW",
    });
    expect(done.result.details.effect).not.toBe("not-applied");
    expect(await f.content("t.txt")).toBe(lines("END early", "END again", "NEW", "after"));
  });

  test("only matches after the first boundary are listed, nearest first", async () => {
    const source = lines("END a", "BEGIN", "END b", "END c", "END d");
    const f = await fixture({ "t.txt": source });
    const refused = await f.run(deleteMutationTool, {
      path: "t.txt",
      from: "BEGIN",
      through: "END",
    });
    expect(refused.result.details.anchorRecoveries?.[0]?.total).toBe(3);
    expect(refused.text).not.toContain("line 1");
    expect(refused.text).not.toContain(anchorOf(source, 1));
    expect(refused.text.indexOf("line 3")).toBeLessThan(refused.text.indexOf("line 4"));
    expect(refused.text.indexOf("line 4")).toBeLessThan(refused.text.indexOf("line 5"));
  });

  test("at most five candidates are listed and the rest is counted", async () => {
    const source = lines("BEGIN", ...Array.from({ length: 8 }, (_, i) => `END ${i + 1}`));
    const f = await fixture({ "t.txt": source });
    const refused = await f.run(deleteMutationTool, {
      path: "t.txt",
      from: "BEGIN",
      through: "END",
    });
    for (const line of [2, 3, 4, 5, 6]) expect(refused.text).toContain(anchorOf(source, line));
    for (const line of [7, 8, 9]) expect(refused.text).not.toContain(anchorOf(source, line));
    expect(refused.text).toMatch(/\b3 more\b/u);
  });

  test("a match inside the first boundary still ends the range there when it is the only one", async () => {
    const source = lines("pre END", "BEGIN", "END- more", "tail");
    const f = await fixture({ "t.txt": source });
    const done = await f.run(deleteMutationTool, {
      path: "t.txt",
      from: "BEGIN\nEND",
      through: "END",
    });
    expect(done.result.details.effect).not.toBe("not-applied");
    expect(await f.content("t.txt")).toBe(lines("pre END", "- more", "tail"));
  });
});

/** Every selector field, in each tool that has it. */
const source = lines("top", "BEGIN one", "mid END x", "more END y", "last END z", "end");
const destination = lines("SLOT a", "SLOT b", "SLOT c", "stop");
const same = (field: string, value: string) => ({ [field]: value });
interface Case {
  readonly name: string;
  readonly tool: TextMutationToolRegistration;
  readonly input: Record<string, unknown>;
  /** The refused field, the file it selects in and the lines its matches start on. */
  readonly field: string;
  readonly file: "src.txt" | "dst.txt";
  readonly lines: readonly number[];
}
const cases: readonly Case[] = [
  {
    name: "replace at",
    tool: replaceMutationTool,
    input: { path: "src.txt", at: "END", text: "X" },
    field: "at",
    file: "src.txt",
    lines: [3, 4, 5],
  },
  {
    name: "delete at",
    tool: deleteMutationTool,
    input: { path: "src.txt", at: "END" },
    field: "at",
    file: "src.txt",
    lines: [3, 4, 5],
  },
  {
    name: "replace from",
    tool: replaceMutationTool,
    input: { path: "src.txt", from: "END", through: "end", text: "X" },
    field: "from",
    file: "src.txt",
    lines: [3, 4, 5],
  },
  {
    name: "replace after",
    tool: replaceMutationTool,
    input: { path: "src.txt", after: "END", before: "end", text: "X" },
    field: "after",
    file: "src.txt",
    lines: [3, 4, 5],
  },
  {
    name: "replace through",
    tool: replaceMutationTool,
    input: { path: "src.txt", from: "BEGIN", through: "END", text: "X" },
    field: "through",
    file: "src.txt",
    lines: [3, 4, 5],
  },
  {
    name: "delete before",
    tool: deleteMutationTool,
    input: { path: "src.txt", from: "BEGIN", before: "END" },
    field: "before",
    file: "src.txt",
    lines: [3, 4, 5],
  },
  {
    name: "insert after",
    tool: insertMutationTool,
    input: { path: "src.txt", after: "END", text: "X" },
    field: "after",
    file: "src.txt",
    lines: [3, 4, 5],
  },
  {
    name: "insert before",
    tool: insertMutationTool,
    input: { path: "src.txt", before: "END", text: "X" },
    field: "before",
    file: "src.txt",
    lines: [3, 4, 5],
  },
  {
    name: "copy at",
    tool: copyMutationTool,
    input: { path: "src.txt", at: "END", target: "dst.txt", targetAt: "stop" },
    field: "at",
    file: "src.txt",
    lines: [3, 4, 5],
  },
  {
    name: "move through",
    tool: moveMutationTool,
    input: {
      path: "src.txt",
      from: "BEGIN",
      through: "END",
      target: "dst.txt",
      targetAt: "stop",
    },
    field: "through",
    file: "src.txt",
    lines: [3, 4, 5],
  },
  {
    name: "copy targetAt",
    tool: copyMutationTool,
    input: { path: "src.txt", at: "top", target: "dst.txt", targetAt: "SLOT" },
    field: "targetAt",
    file: "dst.txt",
    lines: [1, 2, 3],
  },
  {
    name: "move targetFrom",
    tool: moveMutationTool,
    input: {
      path: "src.txt",
      at: "top",
      target: "dst.txt",
      targetFrom: "SLOT",
      targetThrough: "stop",
    },
    field: "targetFrom",
    file: "dst.txt",
    lines: [1, 2, 3],
  },
  {
    name: "copy targetThrough",
    tool: copyMutationTool,
    input: {
      path: "src.txt",
      at: "top",
      target: "dst.txt",
      targetFrom: "SLOT a",
      targetThrough: "SLOT",
    },
    field: "targetThrough",
    file: "dst.txt",
    lines: [1, 2, 3],
  },
  {
    name: "move targetBefore",
    tool: moveMutationTool,
    input: {
      path: "src.txt",
      at: "top",
      target: "dst.txt",
      targetAfter: "SLOT a",
      targetBefore: "SLOT",
    },
    field: "targetBefore",
    file: "dst.txt",
    lines: [2, 3],
  },
  {
    name: "copy targetAfter",
    tool: copyMutationTool,
    input: { path: "src.txt", at: "top", target: "dst.txt", targetAfter: "SLOT" },
    field: "targetAfter",
    file: "dst.txt",
    lines: [1, 2, 3],
  },
];

describe.each(cases)("$name refuses an ambiguous match and lists candidates", (item) => {
  test("nothing changes, candidates carry line numbers and anchors, and the example works", async () => {
    const f = await fixture({ "src.txt": source, "dst.txt": destination });
    const content = item.file === "src.txt" ? source : destination;
    const refused = await f.run(item.tool, item.input);
    expect(refused.result.details.effect).toBe("not-applied");
    expect(await f.content("src.txt")).toBe(source);
    expect(await f.content("dst.txt")).toBe(destination);
    expect(refused.result.details.anchorRecoveries?.[0]?.total).toBe(item.lines.length);

    for (const line of item.lines) {
      expect(refused.text).toContain(`line ${line}`);
      expect(refused.text).toContain(anchorOf(content, line));
    }
    // One ready call, written for the refused field with the first candidate's anchor.
    const first = anchorOf(content, item.lines[0] ?? 1);
    expect(refused.text).toMatch(new RegExp(`${item.field}: "${first}"`, "u"));

    const retried = await f.run(item.tool, { ...item.input, ...same(item.field, first) });
    expect(retried.result.details.effect, retried.text).not.toBe("not-applied");
  });
});
