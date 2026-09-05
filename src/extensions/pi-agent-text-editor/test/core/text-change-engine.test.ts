import { describe, expect, test } from "vitest";

import { applyTextChanges, TextChangeDocument } from "#src/core/text-change-engine.js";

describe("text change engine", () => {
  test("applies replacements, insertions, deletions, and full replacements", () => {
    expect(applyTextChanges("abcdef", [{ from: 1, to: 3, insert: "X" }]).content).toBe("aXdef");
    expect(applyTextChanges("abcdef", [{ from: 3, to: 3, insert: "X" }]).content).toBe("abcXdef");
    expect(applyTextChanges("abcdef", [{ from: 1, to: 3, insert: "" }]).content).toBe("adef");
    expect(applyTextChanges("abcdef", [{ from: 0, to: 6, insert: "new" }]).content).toBe("new");
  });

  test("applies unordered non-overlapping changes against the original text", () => {
    const result = applyTextChanges("alpha beta gamma", [
      { from: 11, to: 16, insert: "G" },
      { from: 0, to: 5, insert: "A" },
    ]);

    expect(result.content).toBe("A beta G");
  });

  test("keeps the input order for insertions at the same boundary", () => {
    expect(
      applyTextChanges("ab", [
        { from: 1, to: 1, insert: "X" },
        { from: 1, to: 1, insert: "Y" },
      ]).content,
    ).toBe("aXYb");
  });

  test("rejects invalid and overlapping changes", () => {
    expect(() => applyTextChanges("abc", [{ from: -1, to: 1, insert: "" }])).toThrow("outside");
    expect(() =>
      applyTextChanges("abcdef", [
        { from: 1, to: 4, insert: "x" },
        { from: 3, to: 5, insert: "y" },
      ]),
    ).toThrow("overlap");
  });

  test("rejects a change that leaves its selected text unchanged", () => {
    expect(() => applyTextChanges("alpha", [{ from: 0, to: 5, insert: "alpha" }])).toThrow(
      "must change",
    );
  });

  test("reports coordinates and text before and after the change", () => {
    expect(applyTextChanges("abc", [{ from: 1, to: 2, insert: "XYZ" }]).changes).toEqual([
      {
        fromBefore: 1,
        toBefore: 2,
        fromAfter: 1,
        toAfter: 4,
        removedText: "b",
        insertedText: "XYZ",
      },
    ]);
  });
});

describe("text change document", () => {
  test("selects inclusive line ranges in either direction", () => {
    const document = new TextChangeDocument("one\ntwo\nthree");
    expect(document.lineRange(2, 3)).toEqual({ from: 4, to: 13 });
    expect(document.lineRange(3, 2)).toEqual({ from: 4, to: 13 });
    expect(document.text(document.lineRange(2, 2))).toBe("two\n");
  });

  test("replaces and deletes first and last lines without changing unrelated separators", () => {
    const document = new TextChangeDocument("one\ntwo\nthree");
    expect(applyTextChanges(document.content, [document.replaceLines(1, 1, "ONE")]).content).toBe(
      "ONE\ntwo\nthree",
    );
    expect(applyTextChanges(document.content, [document.deleteLines(3, 3)]).content).toBe(
      "one\ntwo",
    );
  });

  test("handles a final newline and an empty document", () => {
    const finalNewline = new TextChangeDocument("one\ntwo\n");
    expect(applyTextChanges(finalNewline.content, [finalNewline.deleteLines(2, 2)]).content).toBe(
      "one\n",
    );

    const empty = new TextChangeDocument("");
    expect(applyTextChanges(empty.content, [empty.replaceAll("first")]).content).toBe("first");
    expect(applyTextChanges(empty.content, [empty.insertAfterLine(1, "first")]).content).toBe(
      "first",
    );
  });

  test("inserts before and after lines with the document line ending", () => {
    const lf = new TextChangeDocument("one\ntwo");
    expect(applyTextChanges(lf.content, [lf.insertBeforeLine(1, "zero")]).content).toBe(
      "zero\none\ntwo",
    );
    expect(applyTextChanges(lf.content, [lf.insertAfterLine(2, "three")]).content).toBe(
      "one\ntwo\nthree",
    );

    const crlf = new TextChangeDocument("one\r\ntwo\r\nthree");
    expect(applyTextChanges(crlf.content, [crlf.replaceLines(2, 2, "TWO")]).content).toBe(
      "one\r\nTWO\r\nthree",
    );
    expect(applyTextChanges(crlf.content, [crlf.insertAfterLine(1, "middle")]).content).toBe(
      "one\r\nmiddle\r\ntwo\r\nthree",
    );
  });

  test("applies a same-document move as one changeset", () => {
    const document = new TextChangeDocument("one\ntwo\nthree\nfour");
    const range = document.lineRange(2, 2);
    const changes = [document.deleteLines(2, 2), document.insertAfterLine(4, document.text(range))];

    expect(applyTextChanges(document.content, changes).content).toBe("one\nthree\nfour\ntwo");
  });

  test("rejects a move whose target is inside the removed range", () => {
    const document = new TextChangeDocument("one\ntwo\nthree");
    expect(() =>
      applyTextChanges(document.content, [
        document.deleteLines(2, 2),
        document.insertAfterLine(1, "two\n"),
      ]),
    ).toThrow("overlap");
  });
});
