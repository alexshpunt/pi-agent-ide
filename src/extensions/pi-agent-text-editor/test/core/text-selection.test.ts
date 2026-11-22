import { expect, test } from "vitest";

import type { TextMutationContext } from "#src/api/mutation-tool.ts";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.ts";
import { applyTextChanges, TextChangeDocument } from "#src/core/text-change-engine.ts";
import { insertionChanges, selectionChanges } from "#src/tools/text-selection.ts";

test("removes the preceding separator when an exact match is the last line (LPT-1747)", () => {
  const source = "source.txt";
  const document = new TextChangeDocument("header\nneedle");
  const context = {
    documentFor: (value: string) => {
      expect(value).toBe(source);
      return document;
    },
  } as Pick<TextMutationContext, "documentFor">;
  const anchor = new TextSelectionAnchor(source, source, [
    {
      start: { lineNumber: 2, column: 0 },
      end: { lineNumber: 2, column: 6 },
    },
  ]);

  const changes = selectionChanges(context as TextMutationContext, new Map([[source, anchor]]), "");

  expect(changes.get(source)).toEqual([{ from: 6, to: 13, insert: "" }]);
  expect(applyTextChanges(document.content, changes.get(source) ?? []).content).toBe("header");
});

test("coalesces adjacent no-LF linewise deletions into one non-overlapping change", () => {
  const source = "source.txt";
  const document = new TextChangeDocument("needle\nneedle");
  const context = {
    documentFor: () => document,
  } as Pick<TextMutationContext, "documentFor">;
  const anchor = new TextSelectionAnchor(source, source, [
    {
      start: { lineNumber: 1, column: 0 },
      end: { lineNumber: 2, column: 0 },
      linewise: true,
    },
    {
      start: { lineNumber: 2, column: 0 },
      end: { lineNumber: 2, column: 6 },
      linewise: true,
    },
  ]);

  const changes = selectionChanges(
    context as TextMutationContext,
    new Map([[source, anchor]]),
    "",
  ).get(source);

  expect(changes).toEqual([{ from: 0, to: 13, insert: "" }]);
  expect(applyTextChanges(document.content, changes ?? []).content).toBe("");
});

test("coalesces adjacent CRLF linewise deletions into one non-overlapping change", () => {
  const source = "source.txt";
  const document = new TextChangeDocument("needle\r\nneedle");
  const context = { documentFor: () => document } as Pick<TextMutationContext, "documentFor">;
  const anchor = new TextSelectionAnchor(source, source, [
    {
      start: { lineNumber: 1, column: 0 },
      end: { lineNumber: 2, column: 0 },
      linewise: true,
    },
    {
      start: { lineNumber: 2, column: 0 },
      end: { lineNumber: 2, column: 6 },
      linewise: true,
    },
  ]);

  const changes = selectionChanges(
    context as TextMutationContext,
    new Map([[source, anchor]]),
    "",
  ).get(source);

  expect(changes).toEqual([{ from: 0, to: 14, insert: "" }]);
  expect(applyTextChanges(document.content, changes ?? []).content).toBe("");
});

test("coalesces adjacent exact matches that cover whole lines (LPT-1747)", () => {
  const source = "source.txt";
  const document = new TextChangeDocument("needle\nneedle");
  const context = { documentFor: () => document } as Pick<TextMutationContext, "documentFor">;
  const anchor = new TextSelectionAnchor(source, source, [
    {
      start: { lineNumber: 1, column: 0 },
      end: { lineNumber: 1, column: 6 },
    },
    {
      start: { lineNumber: 2, column: 0 },
      end: { lineNumber: 2, column: 6 },
    },
  ]);

  const changes = selectionChanges(
    context as TextMutationContext,
    new Map([[source, anchor]]),
    "",
  ).get(source);

  expect(changes).toEqual([{ from: 0, to: 13, insert: "" }]);
  expect(applyTextChanges(document.content, changes ?? []).content).toBe("");
});

test("inserts before a whole-line selection", () => {
  const source = "source.txt";
  const document = new TextChangeDocument("before\nanchor\nafter\n");
  const context = { documentFor: () => document } as Pick<TextMutationContext, "documentFor">;
  const anchor = new TextSelectionAnchor(source, source, [
    {
      start: { lineNumber: 2, column: 0 },
      end: { lineNumber: 3, column: 0 },
      linewise: true,
    },
  ]);

  const changes = insertionChanges(
    context as TextMutationContext,
    new Map([[source, anchor]]),
    "inserted\n",
    true,
  ).get(source);

  expect(applyTextChanges(document.content, changes ?? []).content).toBe(
    "before\ninserted\nanchor\nafter\n",
  );
});
