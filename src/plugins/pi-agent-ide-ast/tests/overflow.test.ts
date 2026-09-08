import { expect, test } from "vitest";
import { createTextDocument } from "pi-agent-text";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { ReadPipelineContext } from "pi-agent-read/api/tools/read";
import { createAstOverflowHandler } from "#src/overflow-handler.js";
import { AstOutlineManager } from "#src/ast/outline.js";

const source = `test("checkout", () => {\n${"  check(value);\n".repeat(2100)}});\n`;
function context(content = source, file = "sample.ts", displayed = content): ReadPipelineContext {
  return {
    request: { path: file },
    resolverContext: { cwd: process.cwd() },
    state: {
      source: file,
      resolvedBy: "filesystem",
      preserveTruncatedOutput: true,
      textMode: "normal",
      contentKind: "text",
      content: [{ type: "text", text: content }],
      text: createTextDocument(file, content),
    },
    result: { content: [{ type: "text", text: displayed }], details: { source: file } },
  };
}

test("overflow returns the whole compact tree from the read snapshot", async () => {
  const result = await createAstOverflowHandler()(context());
  expect(result.kind).toBe("return");
  if (result.kind !== "return") throw new Error("Missing overview");
  expect(result.result.details.resolvedBy).toBe("ast-overflow");
  const block = result.result.content[0];
  if (block?.type !== "text") throw new Error("Missing text");
  expect(truncateHead(block.text).truncated).toBe(false);
  expect(block.text).toContain('1 | test("checkout", () => {');
  expect(block.text).toContain("2102 | });");
  expect(block.text).not.toContain("check(value)");
});

test("Unicode before a collapsed body keeps source coordinates", async () => {
  const input = context(source.replace("checkout", "付款 🛒"));
  const result = await createAstOverflowHandler()(input);
  expect(result.kind).toBe("return");
  if (result.kind !== "return") throw new Error("Missing overview");
  const block = result.result.content[0];
  if (block?.type !== "text") throw new Error("Missing text");
  expect(block.text).toContain('1 | test("付款 🛒", () => {');
  expect(block.text).toContain("2102 | });");
});
test("small windows in large files remain exact", async () => {
  const input = context(source, "sample.ts", "  check(value);\n".repeat(20));
  expect(await createAstOverflowHandler()(input)).toEqual({ kind: "continue", context: input });
});

test("CRLF snapshots use the parser's line coordinates", async () => {
  const result = await createAstOverflowHandler()(context(source.replaceAll("\n", "\r\n")));
  expect(result.kind).toBe("return");
  if (result.kind !== "return") throw new Error("Missing overview");
  const block = result.result.content[0];
  if (block?.type !== "text") throw new Error("Missing text");
  expect(block.text).toContain("2102 | });");
});
test("byte overflow also triggers an overview", async () => {
  const input = context(`function work() {\n  return "${"x".repeat(60000)}";\n}\n`);
  expect((await createAstOverflowHandler()(input)).kind).toBe("return");
});

test("unsupported and invalid source keep normal truncation", async () => {
  for (const input of [
    context(source, "sample.txt"),
    context(`function broken( {\n${"  check(value);\n".repeat(2100)}`),
  ]) {
    expect(await createAstOverflowHandler()(input)).toEqual({ kind: "continue", context: input });
  }
});

test("flat oversized outlines reduce to file-only detail within budget", async () => {
  const input = context("import 'package';\n".repeat(2100));
  const result = await createAstOverflowHandler()(input);
  expect(result.kind).toBe("return");
  if (result.kind !== "return") throw new Error("Missing overview");
  expect(result.result.details.resolvedBy).toBe("ast-overflow");
  const block = result.result.content[0];
  if (block?.type !== "text") throw new Error("Missing text");
  expect(truncateHead(block.text).truncated).toBe(false);
  expect(block.text).not.toContain("import 'package'");
});

test("budget reduction stops at the first fitting depth", async () => {
  const lines = [
    "class Example {",
    ...Array.from({ length: 100 }, (_, i) => `  field${i}: string;`),
    "}",
  ];
  const sizes: number[] = [];
  const outline = await new AstOutlineManager(12).readDocumentOutline(
    "example.ts",
    process.cwd(),
    lines,
    (candidate) => {
      sizes.push(candidate.renderedLines.length);
      return candidate.renderedLines.length < 10;
    },
  );
  expect(sizes.length).toBeGreaterThan(1);
  expect(sizes.slice(0, -1).every((size) => size >= 10)).toBe(true);
  expect(outline.renderedLines.length).toBeLessThan(10);
  expect(outline.renderedLines.some((line) => line.text.includes("class Example"))).toBe(true);
});
test("depth limiting retains original source positions", async () => {
  const content = `${'{"nested":\n'.repeat(20)}0${"\n}".repeat(20)}`;
  const lines = content.split("\n");
  const outline = await new AstOutlineManager(12).readDocumentOutline(
    "deep.json",
    process.cwd(),
    lines,
  );
  expect(outline.renderedLines.length).toBeLessThan(lines.length);
  for (const line of outline.renderedLines) {
    if (line.sourceLine)
      expect(line.sourceLine.content).toBe(lines[line.sourceLine.lineNumber - 1]);
  }
});
