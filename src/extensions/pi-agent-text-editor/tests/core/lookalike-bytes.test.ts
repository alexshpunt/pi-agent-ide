import { describe, expect, test } from "vitest";
import { keepLookalikeBytes } from "#src/core/lookalike-bytes.ts";
import { applyTextChanges, TextChangeDocument } from "#src/core/text-change-engine.ts";

const NBSP = "\u00A0";

describe("keepLookalikeBytes", () => {
  test.each([
    ["a no-break space", `a${NBSP}b = 1;`, "a b = 2;", `a${NBSP}b = 2;`],
    ["an em space", "a\u2003b = 1;", "a b = 2;", "a\u2003b = 2;"],
    ["a narrow no-break space", "a\u202Fb = 1;", "a b = 2;", "a\u202Fb = 2;"],
    ["an ideographic space", "a\u3000b = 1;", "a b = 2;", "a\u3000b = 2;"],
    ["smart double quotes", "\u201Chi\u201D 1", '"hi" 2', "\u201Chi\u201D 2"],
    [
      "smart single quotes",
      "it\u2019s \u2018fine\u2019 1",
      "it's 'fine' 2",
      "it\u2019s \u2018fine\u2019 2",
    ],
    ["an en dash", "a \u2013 b 1", "a - b 2", "a \u2013 b 2"],
    ["a minus sign", "a \u2212 b 1", "a - b 2", "a \u2212 b 2"],
    ["a non-breaking hyphen", "a\u2011b 1", "a-b 2", "a\u2011b 2"],
  ])("keeps %s next to a real change", (_name, original, sent, expected) => {
    expect(keepLookalikeBytes(original, sent)).toBe(expected);
  });

  test("keeps the look-alike characters before and after the change", () => {
    const original = `a${NBSP}b = \u201Cx\u201D \u2013 y;${NBSP}// c`;
    const sent = 'a b = "x" - z; // c';
    expect(keepLookalikeBytes(original, sent)).toBe(
      `a${NBSP}b = \u201Cx\u201D \u2013 z;${NBSP}// c`,
    );
  });

  test("keeps them across lines and CRLF line endings", () => {
    const original = `a${NBSP}b\r\nc${NBSP}d\r\ne`;
    expect(keepLookalikeBytes(original, "a b\r\nc d\r\nf")).toBe(`a${NBSP}b\r\nc${NBSP}d\r\nf`);
  });

  test("writes a changed look-alike as sent when the real change touches it", () => {
    expect(keepLookalikeBytes(`a${NBSP}b`, "a_b")).toBe("a_b");
    expect(keepLookalikeBytes(`a${NBSP}b`, "ab")).toBe("ab");
    expect(keepLookalikeBytes("ab", `a${NBSP}b`)).toBe(`a${NBSP}b`);
  });

  test("writes the text as sent when it equals the original only under the equivalence", () => {
    expect(keepLookalikeBytes(`export${NBSP}default routes;`, "export default routes;")).toBe(
      "export default routes;",
    );
    expect(keepLookalikeBytes("say \u201Chi\u201D \u2013 now", 'say "hi" - now')).toBe(
      'say "hi" - now',
    );
  });

  test("writes a byte-identical text as it is", () => {
    expect(keepLookalikeBytes(`a${NBSP}b`, `a${NBSP}b`)).toBe(`a${NBSP}b`);
  });

  test("keeps composed and decomposed characters and a full-width letter as a look-alike", () => {
    expect(keepLookalikeBytes("caf\u00E9 x", "cafe\u0301 y")).toBe("caf\u00E9 y");
    expect(keepLookalikeBytes("\uFF21 = 1", "A = 2")).toBe("\uFF21 = 2");
  });

  test("never splits a surrogate pair or a base with its mark", () => {
    expect(keepLookalikeBytes("\u{1F600}\u{1F601} x", "\u{1F600}\u{1F602} x")).toBe(
      "\u{1F600}\u{1F602} x",
    );
    expect(keepLookalikeBytes("e\u0301 x", "e\u0300 x")).toBe("e\u0300 x");
  });

  test("writes a rewrite as sent", () => {
    const original = `${NBSP}x`.repeat(2000);
    const sent = " y".repeat(2000);
    expect(keepLookalikeBytes(original, sent)).toBe(sent);
  });

  test("stays fast on a 4.5 MB span with look-alikes and two changes", () => {
    const line = `const${NBSP}value = \u201Cabcdefghij\u201D;\n`;
    const original = line.repeat(165_000);
    const plain = 'const value = "abcdefghij";\n'.repeat(165_000);
    const middle = Math.floor(165_000 / 2) * 28;
    const sent = `${plain.slice(0, 280)}CHANGED${plain.slice(287, middle)}CHANGED${plain.slice(middle + 7)}`;
    expect(original.length).toBeGreaterThan(4_000_000);
    const started = performance.now();
    const written = keepLookalikeBytes(original, sent);
    expect(performance.now() - started).toBeLessThan(2500);
    expect(written.length).toBe(original.length);
    expect(written.startsWith(`const${NBSP}value = \u201Cabcdefghij\u201D;\n`)).toBe(true);
    expect(written.slice(280, 287)).toBe("CHANGED");
    expect(written.slice(middle, middle + 7)).toBe("CHANGED");
    expect(written.slice(-line.length)).toBe(line);
  }, 30_000);
});

describe("TextChangeDocument.replace", () => {
  const content = `head\nexport${NBSP}default routes;\ntail\n`;

  function replaced(document: TextChangeDocument, text: string, line = 2): string {
    return applyTextChanges(content, [document.replace(document.lineSpan(line, line), text)])
      .content;
  }

  test("keeps the original bytes of a retyped line next to a real change", () => {
    expect(replaced(new TextChangeDocument(content), "export default routeTable;")).toBe(
      `head\nexport${NBSP}default routeTable;\ntail\n`,
    );
  });

  test("writes a deliberate whole-span normalization as sent", () => {
    expect(replaced(new TextChangeDocument(content), "export default routes;")).toBe(
      "head\nexport default routes;\ntail\n",
    );
  });

  test("changes nothing outside the span", () => {
    const document = new TextChangeDocument(`\uFEFFa${NBSP}b\r\nc${NBSP}d\r\ne`);
    const change = document.replace(document.lineSpan(2, 2), "c d!");
    expect(applyTextChanges(document.content, [change]).content).toBe(
      `\uFEFFa${NBSP}b\r\nc${NBSP}d!\r\ne`,
    );
  });

  test("writes copied bytes verbatim", () => {
    const document = new TextChangeDocument(content);
    const change = document.replace(document.lineSpan(2, 2), {
      text: "export default routes;",
      wholeLines: true,
    });
    expect(change.insert).toBe("export default routes;");
  });

  test("leaves an insertion as sent", () => {
    const document = new TextChangeDocument(content);
    expect(document.insert(document.lineSpan(1, 1), `x${NBSP}y`).insert).toContain(`x${NBSP}y`);
    expect(document.insert(document.lineSpan(1, 1), "x y").insert).toContain("x y");
  });
});
