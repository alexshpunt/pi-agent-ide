import { expect, test } from "vitest";
import { TextAnchor } from "pi-agent-text";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";
import { TextChangeDocument } from "#src/core/text-change-engine.js";
import type { TextMutationContext } from "#src/api/mutation-tool.js";
import {
  anchorSpanRange,
  insertionChanges,
  singleAnchorSpan,
  replaceAnchorSpan,
  deleteAnchorSpan,
} from "#src/tools/text-selection.js";

const source = "fixture";
const document = new TextChangeDocument("left START right\r\nmiddle\r\nleft END right\r\nlast");
class Position extends TextAnchor {
  public constructor(value: string, line: number) {
    super(value, line);
  }
}
const context: TextMutationContext = {
  cwd: process.cwd(),
  sourceDocument: document,
  documentFor: () => document,
  targetDocument: () => document,
  sourceFor: () => source,
  resolveAnchors: () => Promise.reject(new Error("Unexpected anchor resolution")),
  resolveAnchor: () => Promise.reject(new Error("Unexpected anchor resolution")),
};
const map = (anchor: TextAnchor, file = source) => new Map([[file, anchor]]);

test.each(["\n", "\r\n"])(
  "empty replacement matches deletion without adding a line (%j)",
  (eol) => {
    for (const content of [
      `A${eol}BLOCK${eol}${eol}B${eol}`,
      `A${eol}BLOCK`,
      `BLOCK${eol}`,
      "BLOCK",
    ]) {
      const doc = new TextChangeDocument(content);
      const ctx = {
        ...context,
        sourceDocument: doc,
        documentFor: () => doc,
        targetDocument: () => doc,
      };
      const line = content.startsWith("A") ? 2 : 1;
      const anchors = map(new Position("block", line));
      for (const end of [undefined, anchors]) {
        const span = anchorSpanRange(ctx, anchors, end, "start", "end");
        const replacement = replaceAnchorSpan(ctx, span, "");
        expect(replacement).toEqual(deleteAnchorSpan(ctx, span));
        const actual =
          content.slice(0, replacement.from) + replacement.insert + content.slice(replacement.to);
        expect(actual).toBe(
          content.startsWith("A") ? (content.endsWith("BLOCK") ? "A" : `A${eol}${eol}B${eol}`) : "",
        );
      }
    }
  },
);
const match = (line: number, column: number, endLine: number, endColumn: number) =>
  new TextSelectionAnchor("selection", source, [
    { start: { lineNumber: line, column }, end: { lineNumber: endLine, column: endColumn } },
  ]);

test("mixed endpoints select whole CRLF lines while a single match stays exact", () => {
  const start = map(match(1, 5, 1, 10));
  const end = map(new Position("end", 3));
  expect(document.text(anchorSpanRange(context, start, end, "start", "end"))).toBe(
    "left START right\r\nmiddle\r\nleft END right\r\n",
  );
  expect(document.text(singleAnchorSpan(context, start, "start"))).toBe("START");
});

test("multiline match ending at column zero does not include the next line", () => {
  const span = singleAnchorSpan(context, map(match(1, 5, 3, 0)), "start", true);
  expect(document.text(span)).toBe("left START right\r\nmiddle\r\n");
});

test("reversed, cross-resource and plural endpoints are rejected", () => {
  const first = map(match(1, 5, 1, 10));
  const later = map(match(1, 11, 1, 16));
  expect(() => anchorSpanRange(context, later, first, "start", "end")).toThrow(
    "must not come after",
  );
  expect(() =>
    anchorSpanRange(context, first, map(new Position("end", 3), "other"), "start", "end"),
  ).toThrow("one resource");
  const plural = new TextSelectionAnchor("many", source, [
    { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 4 } },
    { start: { lineNumber: 1, column: 5 }, end: { lineNumber: 1, column: 10 } },
  ]);
  expect(() => anchorSpanRange(context, map(plural), first, "start", "end")).toThrow("one match");
});

test("all-match insertions are deduplicated by containing line", () => {
  const plural = new TextSelectionAnchor("many", source, [
    { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 4 } },
    { start: { lineNumber: 1, column: 5 }, end: { lineNumber: 1, column: 10 } },
  ]);
  for (const before of [false, true]) {
    const changes = insertionChanges(context, new Map([[source, plural]]), "NEW\n", before).get(
      source,
    );
    expect(changes).toHaveLength(1);
    expect(changes?.[0]?.insert).toBe("NEW\r\n");
  }
});
