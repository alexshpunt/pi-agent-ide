import { expect, test } from "vitest";
import { resolveExactTextAnchor } from "pi-agent-text-anchor-exact/api/anchor";
import { TextChangeDocument } from "#src/core/text-change-engine.js";
import { anchorSpanRange, deleteAnchorSpan, replaceAnchorSpan } from "#src/tools/text-selection.js";
import type { TextMutationContext } from "#src/api/mutation-tool.js";

function fixture(content: string) {
  const source = "fixture.txt";
  const document = new TextChangeDocument(content);
  const context: TextMutationContext = {
    cwd: process.cwd(),
    sourceDocument: document,
    documentFor: () => document,
    targetDocument: () => document,
    sourceFor: () => source,
    resolveAnchors: () => Promise.reject(new Error("Unexpected anchor resolution")),
    resolveAnchor: () => Promise.reject(new Error("Unexpected anchor resolution")),
  };
  const resolve = (value: string) => {
    const result = resolveExactTextAnchor(value, {
      source,
      content,
      lines: content.split(/\r\n|\r|\n/u),
      cwd: context.cwd,
    });
    if (result.kind !== "resolved") throw new Error("Expected a unique exact match");
    return new Map([[source, result.anchor]]);
  };
  const span = (start: string, end?: string) =>
    anchorSpanRange(
      context,
      resolve(start),
      end === undefined ? undefined : resolve(end),
      "start",
      "end",
    );
  const replace = (start: string, end: string | undefined, text: string) => {
    const change = replaceAnchorSpan(context, span(start, end), text);
    return content.slice(0, change.from) + change.insert + content.slice(change.to);
  };
  return { document, context, span, replace };
}

test.each(["\n", "\r\n"])("leading newlines do not select the previous paragraph (%j)", (eol) => {
  const content = `## Leave alone${eol}${eol}Keep this paragraph.${eol}${eol}Based on [source](url).${eol}`;
  const { replace } = fixture(content);
  expect(replace("\n\nBased on", "(url).", "")).toBe(
    `## Leave alone${eol}${eol}Keep this paragraph.${eol}`,
  );
});

test.each(["\n", "\r\n"])(
  "paired exact whole-line text keeps its trailing separator outside (%j)",
  (eol) => {
    const { replace } = fixture(`before${eol}START${eol}END${eol}after${eol}`);
    expect(replace("START", "END", "NEW")).toBe(`before${eol}NEW${eol}after${eol}`);
    expect(replace("START", "END", "")).toBe(`before${eol}${eol}after${eol}`);
    expect(replace("START", undefined, "NEW")).toBe(`before${eol}NEW${eol}END${eol}after${eol}`);
  },
);

test("paired endpoints replace only the selected part of a sentence", () => {
  const { replace } = fixture("Keep the START old words END and this suffix.");
  expect(replace("START", "END", "new words")).toBe("Keep the new words and this suffix.");
});

test("multiline exact endpoints keep their own character boundaries", () => {
  const { replace } = fixture("prefix START\ncontinued\nmiddle\nEND\ncontinued suffix");
  expect(replace("START\ncontinued", "END\ncontinued", "NEW")).toBe("prefix NEW suffix");
});

test.each(["\n", "\r\n"])(
  "exact deletion through EOF keeps the preceding separator (%j)",
  (eol) => {
    const { span, context, replace } = fixture(`keep${eol}START to END`);
    expect(replace("START", "END", "")).toBe(`keep${eol}`);
    expect(deleteAnchorSpan(context, span("START", "END"))).toEqual({
      from: 4 + eol.length,
      to: 16 + eol.length,
      insert: "",
    });
  },
);
