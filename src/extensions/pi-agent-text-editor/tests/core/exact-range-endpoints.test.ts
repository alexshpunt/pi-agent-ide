import { expect, test } from "vitest";
import { resolveExactTextAnchor } from "pi-agent-text-anchor-exact/api/anchor";
import { TextChangeDocument } from "#src/core/text-change-engine.ts";
import { anchorSpanRange, deleteAnchorSpan, replaceAnchorSpan } from "#src/tools/text-selection.ts";
import type { TextMutationContext } from "#src/api/mutation-tool.ts";

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
      lines: content.split("\n"),
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
  const replace = async (start: string, end: string | undefined, text: string) => {
    const change = replaceAnchorSpan(await span(start, end), text);
    return content.slice(0, change.from) + change.insert + content.slice(change.to);
  };
  /** Copy a single-anchor source over a paired destination span, as Copy does. */
  const copyOver = async (source: string, targetStart: string, targetEnd: string) => {
    const target = await span(targetStart, targetEnd);
    const text = document.text(await span(source));
    const change = { from: target.from, to: target.to, insert: text };
    return content.slice(0, change.from) + change.insert + content.slice(change.to);
  };
  return { document, context, span, replace, copyOver };
}

test.each(["\n", "\r\n"])(
  "a whole-line literal copied over an exact span adds no line break (%j)",
  async (eol) => {
    const { copyOver } = fixture(`alpha${eol}rest${eol}`);
    expect(await copyOver("alpha", "alpha", "alpha")).toBe(`alpha${eol}rest${eol}`);
  },
);

test.each(["\n", "\r\n"])(
  "leading newlines do not select the previous paragraph (%j)",
  async (eol) => {
    const content = `## Leave alone${eol}${eol}Keep this paragraph.${eol}${eol}Based on [source](url).${eol}`;
    const { replace } = fixture(content);
    expect(await replace(`${eol}${eol}Based on`, "(url).", "")).toBe(
      `## Leave alone${eol}${eol}Keep this paragraph.${eol}`,
    );
  },
);

test.each(["\n", "\r\n"])(
  "paired whole-line literals select only their characters (%j)",
  async (eol) => {
    const { replace } = fixture(`before${eol}START${eol}body${eol}END${eol}after${eol}`);
    expect(await replace("START", "END", "NEW")).toBe(`before${eol}NEW${eol}after${eol}`);
    expect(await replace("START", "END", "")).toBe(`before${eol}${eol}after${eol}`);
    expect(await replace("START", undefined, "NEW")).toBe(
      `before${eol}NEW${eol}body${eol}END${eol}after${eol}`,
    );
  },
);

test("a whole-line literal paired with a partial endpoint keeps exact characters", async () => {
  const { replace } = fixture("before\nSTART\nkeep the END here\n");
  expect(await replace("START", "END", "")).toBe("before\n here\n");
});

test("paired endpoints replace only the selected part of a sentence", async () => {
  const { replace } = fixture("Keep the START old words END and this suffix.");
  expect(await replace("START", "END", "new words")).toBe("Keep the new words and this suffix.");
});

test("multiline exact endpoints keep their own character boundaries", async () => {
  const { replace } = fixture("prefix START\ncontinued\nmiddle\nEND\ncontinued suffix");
  expect(await replace("START\ncontinued", "END\ncontinued", "NEW")).toBe("prefix NEW suffix");
});

test.each(["\n", "\r\n"])(
  "exact deletion through EOF keeps the preceding separator (%j)",
  async (eol) => {
    const { span, replace } = fixture(`keep${eol}START to END`);
    expect(await replace("START", "END", "")).toBe(`keep${eol}`);
    expect(deleteAnchorSpan(await span("START", "END"))).toEqual({
      from: 4 + eol.length,
      to: 16 + eol.length,
      insert: "",
    });
  },
);
