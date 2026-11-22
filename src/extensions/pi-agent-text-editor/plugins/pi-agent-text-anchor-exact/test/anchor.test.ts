import { describe, expect, test } from "vitest";

import { TextSelectionAnchor } from "pi-agent-text-editor/api/text-selection-anchor";

import { textLineAnchors } from "pi-agent-text";
import { findExactTextMatches, resolveExactTextAnchor } from "#src/anchor.ts";

function resolve(value: string, content: string, endAfter?: number) {
  return resolveExactTextAnchor(value, {
    source: "fixture.txt",
    content,
    lines: content.split("\n"),
    cwd: "/project",
    ...(endAfter === undefined ? {} : { endAfter }),
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

test("a pasted search highlight resolves to the unmarked source span", () => {
  expect(rangesOf(resolve("// ⟦needle⟧", "// needle\n"))).toEqual([
    { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 9 } },
  ]);
});

test("brackets in actual source text take precedence over stripping", () => {
  expect(rangesOf(resolve("⟦needle⟧", "needle\n⟦needle⟧\n"))).toEqual([
    { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 8 } },
  ]);
});

test("a peeled closing selector counts only matches after the opening selector", () => {
  expect(rangesOf(resolve("⟦END⟧", "END\nSTART\nEND\n", 4))).toEqual([
    { start: { lineNumber: 3, column: 0 }, end: { lineNumber: 3, column: 3 } },
  ]);
});

test("a real bracketed closing match before the opening selector does not redirect the edit", () => {
  expect(resolve("⟦END⟧", "⟦END⟧\n⟦END⟧\nSTART\nEND\n", 12)).toMatchObject({
    kind: "rejected",
    rejection: { code: "before-start" },
  });
});

test("an ambiguous real bracketed match does not fall back to the plain text", () => {
  const result = resolve("⟦needle⟧", "⟦needle⟧\n⟦needle⟧\nneedle\n");
  expect(result).toMatchObject({ kind: "rejected", rejection: { code: "ambiguous" } });
  expect(result.kind === "rejected" && result.rejection.searchHighlightRetry).toBeUndefined();
});

test("a stripped closing selector that only matches before the start is refused", () => {
  const result = resolve("⟦END⟧", "END\nSTART\n", 9);
  expect(result).toMatchObject({ kind: "rejected", rejection: { code: "before-start" } });
  expect(result.kind === "rejected" && result.rejection.reason).toContain("⟦ ⟧");
});

test.each([
  ["⟦needle⟧", "needle\nneedle\n", "ambiguous"],
  ["⟦needle⟧", "unrelated\n", "missing"],
  ["⟦⟧", "needle\n", "missing"],
])("refuses a highlighted selector %j in %j when the retry is %s", (value, content, code) => {
  const result = resolve(value, content);
  expect(result).toMatchObject({ kind: "rejected", rejection: { code } });
  if (result.kind !== "rejected") throw new Error("Expected refusal");
  expect(result.rejection.reason).toContain("⟦ ⟧");
});

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
  const matches = [
    { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 5 } },
    { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 5 } },
  ];
  expect(findExactTextMatches("|alpha", context, 1)).toEqual({
    total: 2,
    ranges: matches.slice(0, 1),
    allMatches: matches,
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

test.each([
  {
    content: "end\r\nmark\r\nSTART\r\nend\r\nmark",
    value: "end\nmark",
    after: 16,
    line: 4,
    endLine: 5,
  },
  {
    content: "end mark\nSTART\nend mark",
    value: "end mark",
    after: 14,
    line: 3,
    endLine: 3,
  },
])(
  "selects the one tolerant match after the start for $value, ignoring earlier ones",
  ({ content, value, after, line, endLine }) => {
    expect(rangesOf(resolve(value, content, after))).toEqual([
      {
        start: { lineNumber: line, column: 0 },
        end: { lineNumber: endLine, column: endLine === line ? 8 : 4 },
      },
    ]);
  },
);

test.each([
  { content: "end\r\nmark\r\nSTART\r\nend\r\nmark\r\nend\r\nmark", value: "end\nmark", after: 16 },
  { content: "end mark\nSTART\nend mark\nend mark", value: "end mark", after: 14 },
  { content: "END line\nSTART\nEND line\nEND line\n", value: "|END", after: 14 },
])("refuses several matches after the start for $value (LPT-1773)", ({ content, value, after }) => {
  expect(resolve(value, content, after)).toMatchObject({
    kind: "rejected",
    rejection: { code: "ambiguous" },
  });
});

test("an anchored-view end after the start ignores earlier copies of the same displayed fragment", () => {
  const content = "END line\nSTART\nEND line\n";
  // A trailing pipe plus source text is enough when the copy starts at the pipe.
  expect(rangesOf(resolve("|END", content, 14))).toEqual([
    { start: { lineNumber: 3, column: 0 }, end: { lineNumber: 3, column: 3 } },
  ]);
});

test("findExactTextMatches lists only the matches after the start", () => {
  const content = "END a\nSTART\nEND b\nEND c\n";
  const found = findExactTextMatches(
    "END",
    { source: "fixture.txt", content, lines: content.split("\n"), cwd: "/project", endAfter: 6 },
    10,
  );
  expect(found.total).toBe(2);
  expect(found.ranges.map((range) => range.start.lineNumber)).toEqual([3, 4]);
});

test("earlier exact matches are not replaced by a fuzzy match after the start", () => {
  expect(resolve("end mark", "end mark\nend mark\nSTART\nend mark", 23)).toMatchObject({
    kind: "rejected",
    rejection: { code: "before-start" },
  });
});

test("an ambiguous first selector is still refused", () => {
  expect(resolve("START", "START first\nSTART second\nEND")).toMatchObject({
    kind: "rejected",
    rejection: { code: "ambiguous" },
  });
});
