import { describe, expect, test } from "vitest";

import { TextSelectionAnchor } from "pi-agent-text-editor/api/text-selection-anchor";

import { textLineAnchors } from "pi-agent-text";
import { findExactTextMatches, resolveExactTextAnchor } from "#src/anchor.ts";

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

test("an LF selector matches CRLF text", () => {
  expect(rangesOf(resolve("bravo\ncharlie", "alpha\r\nbravo\r\ncharlie\r\ndelta"))).toEqual([
    { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 3, column: 7 } },
  ]);
});

test("a CRLF selector matches LF text", () => {
  expect(rangesOf(resolve("bravo\r\ncharlie", "alpha\nbravo\ncharlie\n"))).toEqual([
    { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 3, column: 7 } },
  ]);
});

test("a line break in an LF selector covers the whole CRLF it matches", () => {
  // Ends after the LF of the CRLF.
  expect(rangesOf(resolve("bravo\n", "alpha\r\nbravo\r\ncharlie"))).toEqual([
    { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 3, column: 0 } },
  ]);
  // Starts at the CR of the CRLF.
  expect(rangesOf(resolve("\nbravo", "alpha\r\nbravo"))).toEqual([
    { start: { lineNumber: 1, column: 5 }, end: { lineNumber: 2, column: 5 } },
  ]);
  // An exact match that ends after the CR of a CRLF takes its LF too.
  expect(rangesOf(resolve("alpha\r", "alpha\r\nbravo"))).toEqual([
    { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 2, column: 0 } },
  ]);
  // Text before a CRLF does not take its CR.
  expect(rangesOf(resolve("alpha", "x alpha\r\nbravo"))).toEqual([
    { start: { lineNumber: 1, column: 2 }, end: { lineNumber: 1, column: 7 } },
  ]);
});

test("an exact match wins over a match that only normalized text finds", () => {
  const content = "a\nb x\r\na\r\nb\n";
  expect(rangesOf(resolve("a\r\nb", content))).toEqual([
    { start: { lineNumber: 3, column: 0 }, end: { lineNumber: 4, column: 1 } },
  ]);
  expect(rangesOf(resolve("a\nb", content))).toEqual([
    { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 2, column: 1 } },
  ]);
});

test("a literal that only normalized text finds twice is refused", () => {
  expect(resolve("a\nb", "a\r\nb\na\rb\n")).toMatchObject({
    kind: "rejected",
    rejection: { code: "ambiguous" },
  });
});

describe("fuzzy matching", () => {
  test("ASCII spaces match special spaces, and only the matched characters are selected", () => {
    const content = `  { id: 1,\u00A0retries: 3\u202F},  \nnext\n`;
    expect(rangesOf(resolve("retries: 3 },", content))).toEqual([
      { start: { lineNumber: 1, column: 11 }, end: { lineNumber: 1, column: 24 } },
    ]);
  });

  test("quotes and dashes match their typographic forms", () => {
    expect(rangesOf(resolve('say "hi" - ok', "x say \u201Chi\u201D \u2014 ok\n"))).toEqual([
      { start: { lineNumber: 1, column: 2 }, end: { lineNumber: 1, column: 15 } },
    ]);
  });

  test("trailing whitespace inside a multiline match is selected with it", () => {
    expect(rangesOf(resolve("foo\nbar", "foo  \r\nbar\n"))).toEqual([
      { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 2, column: 3 } },
    ]);
  });

  test("an exact match wins over a fuzzy one", () => {
    const content = "a\u00A0b\na b\n";
    expect(rangesOf(resolve("a b", content))).toEqual([
      { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 3 } },
    ]);
  });

  test("two fuzzy matches are refused", () => {
    expect(resolve("a b", "a\u00A0b\na\u202Fb\n")).toMatchObject({
      kind: "rejected",
      rejection: { code: "ambiguous" },
    });
  });

  test("a match that cuts a character expanded into several is not a match", () => {
    expect(resolve("xf", "x\uFB01y")).toMatchObject({
      kind: "rejected",
      rejection: { code: "missing" },
    });
    expect(rangesOf(resolve("xfi", "x\uFB01y"))).toEqual([
      { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 2 } },
    ]);
  });

  test("combining marks match their composed form", () => {
    expect(rangesOf(resolve("caf\u00E9 au", "le cafe\u0301 au lait"))).toEqual([
      { start: { lineNumber: 1, column: 3 }, end: { lineNumber: 1, column: 11 } },
    ]);
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

test("a selector that starts with the BOM selects it, and matches without it", () => {
  expect(rangesOf(resolve("\uFEFFalpha", "\uFEFFalpha\n"))).toEqual([
    { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 6 } },
  ]);
  expect(rangesOf(resolve("\uFEFFalpha", "alpha\n"))).toEqual([
    { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 5 } },
  ]);
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

function displayLine(content: string, line: number, copiedText: string) {
  return `${textLineAnchors("fixture.txt", content)[line - 1]}|${copiedText}`;
}

test("maps a copy that starts inside the prefix and ends inside the source line", () => {
  const content = "alpha\nbravo charlie\ndelta\n";
  expect(rangesOf(resolve(displayLine(content, 2, "bravo").slice(3), content))).toEqual([
    { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 5 } },
  ]);
});

test("a stale prefix cannot select matching content on a changed line", () => {
  const before = "alpha\nbravo charlie\n";
  const after = "alpha\nbravo delta\n";
  expect(resolve(displayLine(before, 2, "bravo"), after)).toMatchObject({
    kind: "rejected",
    rejection: { code: "missing" },
  });
});

test("fuzzy text matching does not accept a lookalike hash or pipe", () => {
  const content = "bravo\u00a0charlie\n";
  const copied = displayLine(content, 1, "bravo charlie");
  const lookalike = String.fromCharCode(copied.charCodeAt(0) + 0xfee0);
  for (const selector of [lookalike + copied.slice(1), copied.replace("|", "｜")]) {
    expect(resolve(selector, content)).toMatchObject({
      kind: "rejected",
      rejection: { code: "missing" },
    });
  }
});

test("a copied slice may end inside the next line's prefix", () => {
  const content = "alpha\nbravo\ncharlie\n";
  const nextPrefix = displayLine(content, 2, "").slice(0, 3);
  expect(rangesOf(resolve(`pha\n${nextPrefix}`, content))).toEqual([
    { start: { lineNumber: 1, column: 2 }, end: { lineNumber: 2, column: 0 } },
  ]);
});

test("the anchored view counts only matches wholly inside the selection", () => {
  const content = "alpha\nalpha\nalpha\n";
  const context = {
    source: "fixture.txt",
    content,
    lines: content.trimEnd().split("\n"),
    cwd: "/project",
    scope: [{ start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 5 } }],
  };
  expect(rangesOf(resolveExactTextAnchor("|alpha", context))).toEqual(context.scope);
  expect(findExactTextMatches("|alpha", context, 10)).toEqual({ total: 1, ranges: context.scope });
  expect(resolveExactTextAnchor(displayLine(content, 1, "alpha"), context)).toMatchObject({
    kind: "rejected",
    rejection: { code: "outside-scope" },
  });
});

test("plain text wins before trying a displayed line", () => {
  const line = displayLine("bravo\n", 1, "bravo");
  expect(rangesOf(resolve(line, `bravo\n${line}\n`))).toEqual([
    { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: line.length } },
  ]);
});

test("ambiguous displayed text lists the mapped source candidates", () => {
  const content = "alpha\nalpha\n";
  const context = {
    source: "fixture.txt",
    content,
    lines: ["alpha", "alpha"],
    cwd: "/project",
  };
  expect(resolve("|alpha", content)).toMatchObject({
    kind: "rejected",
    rejection: { code: "ambiguous" },
  });
  expect(findExactTextMatches("|alpha", context, 10)).toEqual({
    total: 2,
    ranges: [
      { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 5 } },
      { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 5 } },
    ],
  });
});

test("a copied missing-newline marker does not become part of the span", () => {
  const content = "alpha\nbravo";
  const selector = `${displayLine(content, 2, "bravo")}\n\\ No newline at end of file`;
  expect(rangesOf(resolve(selector, content))).toEqual([
    { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 5 } },
  ]);
});

test("a copied missing-newline marker never makes the selected span include another line", () => {
  const content = "bravo\n\\ No newline at end of file\n";
  const selector = `${displayLine(content, 1, "bravo")}\n\\ No newline at end of file`;
  expect(resolve(selector, content)).toMatchObject({
    kind: "rejected",
    rejection: { code: "missing" },
  });
});

test("allows unique whitespace-only exact text", () => {
  expect(resolve("\t ", "alpha\t bravo")).toMatchObject({ kind: "resolved" });
});
