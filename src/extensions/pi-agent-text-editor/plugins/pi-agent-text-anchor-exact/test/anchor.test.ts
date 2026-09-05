import { expect, test } from "vitest";

import { TextSelectionAnchor } from "pi-agent-text-editor/api/text-selection-anchor";

import { resolveExactTextAnchor } from "#src/anchor.js";

function resolve(value: string, content: string) {
  return resolveExactTextAnchor(value, {
    source: "fixture.txt",
    content,
    lines: content.split(/\r\n|\r|\n/u),
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

test("marks a complete line as linewise", () => {
  const result = resolve("bravo", "alpha\nbravo\ncharlie");
  if (result.kind !== "resolved" || !TextSelectionAnchor.is(result.anchor)) {
    throw new Error("Expected a text selection anchor");
  }
  expect(result.anchor.ranges).toEqual([
    {
      start: { lineNumber: 2, column: 0 },
      end: { lineNumber: 3, column: 0 },
      linewise: true,
    },
  ]);
});

test("maps LF query boundaries back to CRLF source positions", () => {
  const result = resolve("bravo\ncharlie", "alpha\r\nbravo\r\ncharlie\r\ndelta");
  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved" || !TextSelectionAnchor.is(result.anchor)) {
    throw new Error("Expected a text selection anchor");
  }
  expect(result.anchor.ranges).toEqual([
    {
      start: { lineNumber: 2, column: 0 },
      end: { lineNumber: 4, column: 0 },
      linewise: true,
    },
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

test("allows unique whitespace-only exact text", () => {
  expect(resolve("\t ", "alpha\t bravo")).toMatchObject({ kind: "resolved" });
});
