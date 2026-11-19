import { expect, test } from "vitest";

import { TextSelectionAnchor } from "pi-agent-text-editor/api/text-selection-anchor";

import { resolveExactTextAnchor } from "#src/anchor.ts";

function resolve(value: string, content: string) {
  return resolveExactTextAnchor(value, {
    source: "fixture.txt",
    content,
    lines: content.split("\n"),
    cwd: "/project",
  });
}

test("selects one partial-line exact match", () => {
  const result = resolve("bravo", "alpha bravo charlie");
  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved" || !TextSelectionAnchor.is(result.anchor)) {
    throw new Error("Expected a text selection anchor");
  }
  expect(result.anchor.ranges).toEqual([
    { start: { lineNumber: 1, column: 6 }, end: { lineNumber: 1, column: 11 } },
  ]);
});

test("selects exactly a literal that covers a complete line", () => {
  const result = resolve("bravo", "alpha\nbravo\ncharlie");
  if (result.kind !== "resolved" || !TextSelectionAnchor.is(result.anchor)) {
    throw new Error("Expected a text selection anchor");
  }
  expect(result.anchor.ranges).toEqual([
    { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 5 } },
  ]);
  expect(result.anchor.endpointRanges).toBeUndefined();
});

function rangesOf(result: ReturnType<typeof resolve>) {
  if (result.kind !== "resolved" || !TextSelectionAnchor.is(result.anchor)) {
    throw new Error("Expected a text selection anchor");
  }
  return result.anchor.ranges;
}

test.each(["\n", "\r\n"])("keeps blank separators outside an exact match ending in %j", (eol) => {
  expect(
    rangesOf(resolve(`alpha${eol}bravo${eol}`, `alpha${eol}bravo${eol}${eol}charlie${eol}`)),
  ).toEqual([{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 3, column: 0 } }]);
});

test.each(["\n", "\r\n"])("keeps an EOF blank line outside an exact match ending in %j", (eol) => {
  expect(rangesOf(resolve(`alpha${eol}`, `alpha${eol}${eol}`))).toEqual([
    { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 2, column: 0 } },
  ]);
});

test("an LF selector does not match CRLF text", () => {
  expect(resolve("bravo\ncharlie", "alpha\r\nbravo\r\ncharlie\r\ndelta")).toMatchObject({
    kind: "rejected",
    rejection: { code: "missing" },
  });
});

test("a CRLF selector does not match LF text", () => {
  expect(resolve("bravo\r\ncharlie", "alpha\nbravo\ncharlie\n")).toMatchObject({
    kind: "rejected",
    rejection: { code: "missing" },
  });
});

test("a CRLF selector selects the CR and LF bytes it names", () => {
  expect(rangesOf(resolve("bravo\r\ncharlie", "alpha\r\nbravo\r\ncharlie\r\ndelta"))).toEqual([
    { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 3, column: 7 } },
  ]);
});

test("counts only LF as a line break, so a lone CR stays inside its line", () => {
  expect(rangesOf(resolve("target yy\r\ne", "a\r\nb\rc\nd\r\nxx target yy\r\ne"))).toEqual([
    { start: { lineNumber: 4, column: 3 }, end: { lineNumber: 5, column: 1 } },
  ]);
  expect(rangesOf(resolve("d\re", "a\rb\rc\nd\re\n"))).toEqual([
    { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 3 } },
  ]);
});

test("a selector that starts with the BOM selects it", () => {
  expect(rangesOf(resolve("\uFEFFalpha", "\uFEFFalpha\n"))).toEqual([
    { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 6 } },
  ]);
  expect(resolve("\uFEFFalpha", "alpha\n")).toMatchObject({
    kind: "rejected",
    rejection: { code: "missing" },
  });
});

test("preserves an initial BOM outside the selected text", () => {
  const result = resolve("alpha", "\uFEFFalpha");
  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved" || !TextSelectionAnchor.is(result.anchor)) {
    throw new Error("Expected a text selection anchor");
  }
  expect(result.anchor.ranges[0]).toEqual({
    start: { lineNumber: 1, column: 1 },
    end: { lineNumber: 1, column: 6 },
  });
});

test("counts overlapping matches as ambiguous", () => {
  expect(resolve("aaa", "aaaa")).toMatchObject({
    kind: "rejected",
    rejection: { code: "ambiguous" },
  });
});

test("allows unique whitespace-only exact text", () => {
  expect(resolve("\t ", "alpha\t bravo")).toMatchObject({ kind: "resolved" });
});
