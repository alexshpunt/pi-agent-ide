import { expect, test } from "vitest";

import type { TextMutationContext } from "#src/api/mutation-tool.js";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";
import { applyTextChanges, TextChangeDocument } from "#src/core/text-change-engine.js";
import { insertionChanges, selectionChanges } from "#src/tools/text-selection.js";

test("keeps the preceding separator when deleting a non-linewise final match", () => {
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

  expect(changes.get(source)).toEqual([{ from: 7, to: 13, insert: "" }]);
  expect(document.content.slice(0, 7) + document.content.slice(13)).toBe("header\n");
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

test("keeps separators for adjacent non-linewise match deletions", () => {
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

  expect(changes).toEqual([
    { from: 0, to: 6, insert: "" },
    { from: 7, to: 13, insert: "" },
  ]);
  expect(applyTextChanges(document.content, changes ?? []).content).toBe("\n");
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
    "inserted",
    true,
  ).get(source);

  expect(applyTextChanges(document.content, changes ?? []).content).toBe(
    "before\ninserted\nanchor\nafter\n",
  );
});
