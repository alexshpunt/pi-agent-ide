import { expect, test } from "vitest";
import { resolveExactTextAnchor } from "pi-agent-text-anchor-exact/api/anchor";
import { TextChangeDocument } from "#src/core/text-change-engine.js";
import {
  anchorSpanRange,
  deleteAnchorSpan,
  replaceAnchorSpan,
  transferText,
} from "#src/tools/text-selection.js";
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
  /** Copy a single-anchor source over a paired destination span, as Copy does. */
  const copyOver = (source: string, targetStart: string, targetEnd: string) => {
    const target = span(targetStart, targetEnd);
    const text = transferText(context, resolve(source), undefined, span(source), target);
    const change = replaceAnchorSpan(context, target, text);
    return content.slice(0, change.from) + change.insert + content.slice(change.to);
  };
  return { document, context, span, replace, copyOver };
}

test.each(["\n", "\r\n"])(
  "a whole-line literal copied over an exact span adds no line break (%j)",
  (eol) => {
    const { copyOver } = fixture(`alpha${eol}rest${eol}`);
    expect(copyOver("alpha", "alpha", "alpha")).toBe(`alpha${eol}rest${eol}`);
  },
);

test.each(["\n", "\r\n"])("leading newlines do not select the previous paragraph (%j)", (eol) => {
  const content = `## Leave alone${eol}${eol}Keep this paragraph.${eol}${eol}Based on [source](url).${eol}`;
  const { replace } = fixture(content);
  expect(replace("\n\nBased on", "(url).", "")).toBe(
    `## Leave alone${eol}${eol}Keep this paragraph.${eol}`,
  );
});

test.each(["\n", "\r\n"])("paired whole-line markers select their complete lines (%j)", (eol) => {
  const { replace } = fixture(`before${eol}START${eol}body${eol}END${eol}after${eol}`);
  expect(replace("START", "END", "NEW")).toBe(`before${eol}NEW${eol}after${eol}`);
  expect(replace("START", "END", "")).toBe(`before${eol}after${eol}`);
  expect(replace("START", undefined, "NEW")).toBe(
    `before${eol}NEW${eol}body${eol}END${eol}after${eol}`,
  );
});

test("a whole-line marker paired with a partial endpoint keeps exact characters", () => {
  const { replace } = fixture("before\nSTART\nkeep the END here\n");
  expect(replace("START", "END", "")).toBe("before\n here\n");
});

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
