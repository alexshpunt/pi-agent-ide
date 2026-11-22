import { describe, expect, test } from "vitest";

import {
  applyTextChanges,
  TextChangeDocument,
  type TextChange,
} from "#src/core/text-change-engine.ts";

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

  test("keeps a change whose range already has its text", () => {
    const result = applyTextChanges("alpha beta", [
      { from: 0, to: 5, insert: "alpha" },
      { from: 6, to: 10, insert: "BETA" },
    ]);
    expect(result.content).toBe("alpha BETA");
    expect(result.changes.map((change) => change.removedText)).toEqual(["alpha", "beta"]);
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

  test("reports positions after earlier changes, joins touching changes and skips empty ones", () => {
    const result = applyTextChanges("abcdefgh", [
      { from: 6, to: 7, insert: "G" },
      { from: 1, to: 2, insert: "BB" },
      { from: 2, to: 3, insert: "" },
      { from: 4, to: 4, insert: "" },
      { from: 4, to: 4, insert: "1" },
      { from: 4, to: 4, insert: "2" },
    ]);
    expect(result.content).toBe("aBBd12efGh");
    expect(result.changes).toEqual([
      {
        fromBefore: 1,
        toBefore: 3,
        fromAfter: 1,
        toAfter: 3,
        removedText: "bc",
        insertedText: "BB",
      },
      { fromBefore: 4, toBefore: 4, fromAfter: 4, toAfter: 6, removedText: "", insertedText: "12" },
      { fromBefore: 6, toBefore: 7, fromAfter: 8, toAfter: 9, removedText: "g", insertedText: "G" },
    ]);
  });

  test("applies many changes to a large text in one pass", () => {
    const line = "inline int size(const tVec4i& a);\n";
    const source = line.repeat(30_000);
    const changes = Array.from({ length: 30_000 }, (_, index) => ({
      from: index * line.length + 22,
      to: index * line.length + 28,
      insert: "zzVec4",
    }));
    const started = performance.now();
    const result = applyTextChanges(source, changes);
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.content).toBe(source.replaceAll("tVec4i", "zzVec4"));
    expect(result.changes).toHaveLength(30_000);
  });
});

describe("text change document", () => {
  const apply = (document: TextChangeDocument, ...changes: TextChange[]) =>
    applyTextChanges(document.content, changes).content;

  test("selects inclusive line ranges in either direction", () => {
    const document = new TextChangeDocument("one\ntwo\nthree");
    expect(document.lineRange(2, 3)).toEqual({ from: 4, to: 13 });
    expect(document.lineRange(3, 2)).toEqual({ from: 4, to: 13 });
    expect(document.text(document.lineRange(2, 2))).toBe("two\n");
    expect(document.text(document.lineSpan(2, 2))).toBe("two");
  });

  test("replaces and deletes first and last lines without changing unrelated separators", () => {
    const document = new TextChangeDocument("one\ntwo\nthree");
    expect(apply(document, document.replace(document.lineSpan(1, 1), "ONE\n"))).toBe(
      "ONE\ntwo\nthree",
    );
    expect(apply(document, document.delete(document.lineSpan(3, 3)))).toBe("one\ntwo");
  });

  test("replaces the content of whole lines and keeps the last line's ending", () => {
    const document = new TextChangeDocument("one\r\ntwo\nthree");
    expect(apply(document, document.replace(document.lineSpan(1, 1), "ONE"))).toBe(
      "ONE\r\ntwo\nthree",
    );
    expect(apply(document, document.replace(document.lineSpan(2, 2), "2\n"))).toBe(
      "one\r\n2\nthree",
    );
    expect(apply(document, document.replace(document.lineSpan(1, 2), "A\nB"))).toBe(
      "A\r\nB\nthree",
    );
    // A file whose only line ending is a lone CR is one line; its end stays without an ending.
    const cr = new TextChangeDocument("a\rb");
    expect(apply(cr, cr.replace(cr.lineSpan(1, 1), "X\nY\n"))).toBe("X\rY");
  });

  test("counts a CRLF line's CR as its last column", () => {
    const document = new TextChangeDocument("one\r\ntwo\rtwo\nthree");
    expect(document.range(1, 3, 1, 4)).toEqual({ from: 3, to: 4 });
    expect(document.lineNumberAt(9)).toBe(2);
    expect(() => document.range(1, 5, 1, 5)).toThrow(RangeError);
  });

  test("handles a final newline and an empty document", () => {
    const finalNewline = new TextChangeDocument("one\ntwo\n");
    expect(apply(finalNewline, finalNewline.delete(finalNewline.lineSpan(2, 2)))).toBe("one\n");

    const empty = new TextChangeDocument("");
    expect(apply(empty, empty.replaceAll("first"))).toBe("first");
    expect(apply(empty, empty.insert(empty.lineSpan(1, 1), "first"))).toBe("first");
  });

  test("inserts before and after lines with the line ending at the insertion point", () => {
    const lf = new TextChangeDocument("one\ntwo");
    expect(apply(lf, lf.insert(lf.lineSpan(1, 1), "zero\n", { before: true }))).toBe(
      "zero\none\ntwo",
    );
    expect(apply(lf, lf.insert(lf.lineSpan(2, 2), "three\n"))).toBe("one\ntwo\nthree");

    const crlf = new TextChangeDocument("one\r\ntwo\r\nthree");
    expect(apply(crlf, crlf.replace(crlf.lineSpan(2, 2), "TWO\r\n"))).toBe("one\r\nTWO\r\nthree");
    expect(apply(crlf, crlf.insert(crlf.lineSpan(1, 1), "middle\n"))).toBe(
      "one\r\nmiddle\r\ntwo\r\nthree",
    );

    const mixed = new TextChangeDocument("one\r\ntwo\nthree\r\n");
    expect(apply(mixed, mixed.insert(mixed.lineSpan(2, 2), "a\nb", { before: true }))).toBe(
      "one\r\na\nb\ntwo\nthree\r\n",
    );
  });

  for (const ending of ["\n", "\r\n"]) {
    for (const before of [false, true]) {
      test(`uses one break at each edge as a separator or terminator (before=${before}, ending=${JSON.stringify(ending)})`, () => {
        const document = new TextChangeDocument(["prev", "// END X", "next", ""].join(ending));
        for (const leading of [0, 1, 2]) {
          for (const trailing of [0, 1, 2]) {
            const text = "\n".repeat(leading) + "BLOCK1\r\nBLOCK2" + "\n".repeat(trailing);
            const lines = [
              "prev",
              ...(before ? [] : ["// END X"]),
              ...(leading === 2 ? [""] : []),
              "BLOCK1",
              "BLOCK2",
              ...(trailing === 2 ? [""] : []),
              ...(before ? ["// END X"] : []),
              "next",
              "",
            ];
            expect(
              apply(document, document.insert(document.lineSpan(2, 2), text, { before })),
              `leading=${leading}, trailing=${trailing}`,
            ).toBe(lines.join(ending));
          }
        }
      });
    }

    for (const finalBreak of [false, true]) {
      test(`preserves the original EOF ending unless an extra blank line is requested (finalBreak=${finalBreak}, ending=${JSON.stringify(ending)})`, () => {
        const eof = finalBreak ? ending : "";
        const document = new TextChangeDocument(`prev${ending}anchor${eof}`);
        for (const breaks of [0, 1, 2]) {
          const text = ending.repeat(breaks) + `a${ending}b` + ending.repeat(breaks);
          const extra = breaks === 2 ? ending : "";
          expect(apply(document, document.insert(document.lineSpan(2, 2), text))).toBe(
            `prev${ending}anchor${ending}${extra}a${ending}b${extra}${eof}`,
          );
        }
      });
    }

    test(`inserts one empty line per break when the payload is only breaks (${JSON.stringify(ending)})`, () => {
      const document = new TextChangeDocument(["prev", "anchor", "next", ""].join(ending));
      const anchor = document.lineSpan(2, 2);
      for (const count of [1, 2]) {
        const text = ending.repeat(count);
        expect(apply(document, document.insert(anchor, text))).toBe(
          `prev${ending}anchor${ending}${text}next${ending}`,
        );
        expect(apply(document, document.insert(anchor, text, { before: true }))).toBe(
          `prev${ending}${text}anchor${ending}next${ending}`,
        );
      }
    });
  }

  test.each([0, 1, 2, 3])(
    "blank-line separation counts extra payload breaks (%i at each edge)",
    (count) => {
      const document = new TextChangeDocument("prev\nanchor\nnext\n");
      const edge = "\n".repeat(count);
      const text = `${edge}first\nlast${edge}`;
      const gap = count === 3 ? "\n\n\n" : "\n\n";
      const anchor = document.lineSpan(2, 2);
      expect(apply(document, document.insert(anchor, text, { separation: "blank-line" }))).toBe(
        `prev\nanchor${gap}first\nlast${gap}next\n`,
      );
      expect(
        apply(document, document.insert(anchor, text, { separation: "blank-line", before: true })),
      ).toBe(`prev${gap}first\nlast${gap}anchor\nnext\n`);
    },
  );

  test("retains edge breaks mid-line and inserts single-line text as characters at a line edge", () => {
    const document = new TextChangeDocument("anchor\nnext\n");
    expect(apply(document, document.insert({ from: 0, to: 3 }, "\nBLOCK\n"))).toBe(
      "anc\nBLOCK\nhor\nnext\n",
    );
    expect(apply(document, document.insert(document.lineSpan(1, 1), "BLOCK"))).toBe(
      "anchorBLOCK\nnext\n",
    );
    expect(
      apply(document, document.insert(document.lineSpan(1, 1), "BLOCK", { before: true })),
    ).toBe("BLOCKanchor\nnext\n");
  });

  test("preserves blank edge lines and mixed endings in a whole-line transfer", () => {
    const source = new TextChangeDocument("\nBLOCK\r\n\r\nafter\r\n");
    const target = new TextChangeDocument("before\r\nnext\r\n");
    expect(
      apply(target, target.insert(target.lineSpan(1, 1), source.transfer(source.lineSpan(1, 3)))),
    ).toBe("before\r\n\nBLOCK\r\n\r\nnext\r\n");
  });

  test.each(["\n", "\r\n"])("inserts before or after a selected empty line (%j)", (ending) => {
    const document = new TextChangeDocument(["one", "", "two", ""].join(ending));
    const blank = document.lineSpan(2, 2);
    expect(apply(document, document.insert(blank, "added\n", { before: true }))).toBe(
      ["one", "added", "", "two", ""].join(ending),
    );
    expect(apply(document, document.insert(blank, "added\n"))).toBe(
      ["one", "", "added", "two", ""].join(ending),
    );
    // Without a selected empty line, the same end offset is the start of that line.
    const previous = { from: 0, to: document.lineContentStart(2) };
    expect(apply(document, document.insert(previous, "added\n"))).toBe(
      ["one", "added", "", "two", ""].join(ending),
    );
  });

  test("applies a same-document move as one changeset", () => {
    const document = new TextChangeDocument("one\ntwo\nthree\nfour");
    const moved = document.lineSpan(2, 2);
    const changes = [
      document.delete(moved),
      document.insert(document.lineSpan(4, 4), document.transfer(moved)),
    ];

    expect(applyTextChanges(document.content, changes).content).toBe("one\nthree\nfour\ntwo");
  });

  test("copy and move keep an unterminated EOF unterminated", () => {
    const source = "first\nblock\nlast";
    const document = new TextChangeDocument(source);
    const copied = document.transfer(document.lineSpan(2, 2));
    const addition = document.insert(document.lineSpan(3, 3), copied);
    expect(applyTextChanges(source, [addition]).content).toBe("first\nblock\nlast\nblock");
    expect(
      applyTextChanges(source, [document.delete(document.lineSpan(2, 2)), addition]).content,
    ).toBe("first\nlast\nblock");
  });
  test("rejects a move whose target is inside the removed range", () => {
    const document = new TextChangeDocument("one\ntwo\nthree");
    expect(() =>
      applyTextChanges(document.content, [
        document.delete(document.lineSpan(2, 2)),
        document.insert(document.lineSpan(1, 1), "two\n"),
      ]),
    ).toThrow("overlap");
  });
});
