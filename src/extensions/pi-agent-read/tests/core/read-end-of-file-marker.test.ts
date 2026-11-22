import { DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { ResourceResolver } from "pi-agent-resource";
import { NO_FINAL_LINE_BREAK, type TextLinePresenter } from "pi-agent-text";
import { describe, expect, test } from "vitest";

import { createReadTool } from "#src/core/tools/tool-read.ts";

import type { ReadRequest } from "#src/api/tools/read.ts";

const MARKER = NO_FINAL_LINE_BREAK;

function textResolver(content: string, id = "filesystem"): ResourceResolver {
  return {
    id,
    async tryResolve(source) {
      return {
        kind: "resolved",
        resource: { source, read: async () => [{ type: "text", text: content }] },
      };
    },
  };
}

const prefixPresenter: TextLinePresenter = {
  id: "prefix",
  present: (document) => ({
    ...document,
    lines: document.lines.map((line) => ({
      ...line,
      presentation: { prefix: `${line.lineNumber}|` },
    })),
  }),
};

async function read(content: string, request: Partial<ReadRequest> = {}, resolverId?: string) {
  const tool = createReadTool();
  tool.registerContributions("fixture", {
    resolvers: [{ resolver: textResolver(content, resolverId) }],
    views: [{ view: "numbers", presenter: prefixPresenter }],
  });
  try {
    const result = await tool.execute(
      { path: "file.txt", ...request },
      { cwd: process.cwd() },
      "agent",
    );
    const [block] = result.content;
    if (block?.type !== "text") throw new Error("Expected text content");
    return { text: block.text, result };
  } finally {
    await tool.dispose();
  }
}

describe("a file without a final line break", () => {
  test.each([
    ["LF", "one\ntwo", "one\ntwo"],
    ["CRLF", "one\r\ntwo", "one\r\ntwo"],
    ["BOM", "\uFEFFone\ntwo", "\uFEFFone\ntwo"],
    ["one line", "only", "only"],
  ])("ends with the marker after the last line: %s", async (_name, content, shown) => {
    const { text } = await read(content);
    expect(text).toBe(`${shown}\n${MARKER}`);
  });

  test("the marker is not a line: no number, no count, script data stays exact", async () => {
    const { result } = await read("one\ntwo");
    expect(result.details).toMatchObject({ startLine: 1, endLine: 2, totalLines: 2 });
    expect(result.details.lines).toHaveLength(2);
    const script = await readScript("one\ntwo");
    expect(script).toMatchObject({ content: "one\ntwo", totalLines: 2 });
  });

  test("a view that numbers lines gives the marker no prefix", async () => {
    const { text } = await read("one\ntwo", { views: ["numbers"] });
    expect(text).toBe(`1|one\n2|two\n${MARKER}`);
  });

  test("a window that reaches the last line shows the marker, an earlier window does not", async () => {
    expect((await read("a\nb\nc", { offset: 2 })).text).toBe(`b\nc\n${MARKER}`);
    expect((await read("a\nb\nc", { offset: -1 })).text).toBe(`c\n${MARKER}`);
    expect((await read("a\nb\nc", { offset: 2, limit: 2 })).text).toBe(`b\nc\n${MARKER}`);
    expect((await read("a\nb\nc", { limit: 2 })).text).not.toContain(MARKER);
    expect((await read("a\nb\nc", { offset: 2, limit: 1 })).text).not.toContain(MARKER);
  });

  test("a window past the end shows no lines and no marker", async () => {
    expect((await read("a\nb", { offset: 5 })).text).not.toContain(MARKER);
  });

  test("the marker does not count toward the output line limit", async () => {
    const lines = Array.from({ length: DEFAULT_MAX_LINES }, (_, index) => `line ${index + 1}`);
    const fits = await read(lines.join("\n"));
    expect(fits.result.details.truncation).toBeUndefined();
    expect(fits.text.endsWith(`\n${lines.at(-1)}\n${MARKER}`)).toBe(true);

    const over = await read([...lines, "extra"].join("\n"));
    expect(over.result.details.truncation?.truncated).toBe(true);
    expect(over.text).not.toContain(`\n${MARKER}`);
  });
});

describe("text that is not a file", () => {
  test("has no file end to mark", async () => {
    expect((await read("one\ntwo", {}, "linear")).text).toBe("one\ntwo");
  });
});

describe("a source that ends with a line break or is empty", () => {
  test.each([
    ["LF", "one\ntwo\n"],
    ["CRLF", "one\r\ntwo\r\n"],
    ["BOM", "\uFEFFone\n"],
    ["empty", ""],
    ["a single line break", "\n"],
  ])("shows no marker: %s", async (_name, content) => {
    expect((await read(content)).text).not.toContain(MARKER);
    expect((await read(content, { views: ["numbers"] })).text).not.toContain(MARKER);
  });
});

async function readScript(content: string) {
  const tool = createReadTool();
  tool.registerContributions("fixture", { resolvers: [{ resolver: textResolver(content) }] });
  try {
    const result = await tool.execute({ path: "file.txt" }, { cwd: process.cwd() }, "script");
    return result.script;
  } finally {
    await tool.dispose();
  }
}
