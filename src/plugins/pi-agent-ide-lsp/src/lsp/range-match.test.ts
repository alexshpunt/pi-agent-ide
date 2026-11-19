import { createTextDocument } from "pi-agent-text";
import { expect, test } from "vitest";

import { lspRangeMatch } from "./range-match.ts";
import { SOURCE_CHANGED } from "./source-changes.ts";

const range = (line: number, from: number, endLine: number, to: number) => ({
  start: { line, character: from },
  end: { line: endLine, character: to },
});

test("an LSP range in a CRLF file with a BOM selects exactly its characters on LF-only lines", () => {
  const content = "\uFEFFconst a = 1;\r\nconst b = a;\r\n";
  const match = lspRangeMatch("/a.ts", createTextDocument("/a.ts", content), range(1, 10, 1, 11));

  expect(match).toMatchObject({
    lineNumber: 2,
    startColumn: 10,
    endColumn: 11,
    matchedText: "a",
    lineText: "const b = a;\r",
  });
  // The BOM is the first character of line 1, as the server counts it in the synchronized text.
  expect(
    lspRangeMatch("/a.ts", createTextDocument("/a.ts", content), range(0, 7, 0, 8)).matchedText,
  ).toBe("a");
});

test("an LSP range across a CRLF line break keeps the CR in its matched text", () => {
  const content = "first();\r\nsecond();\r\n";
  expect(
    lspRangeMatch("/a.ts", createTextDocument("/a.ts", content), range(0, 0, 1, 6)).matchedText,
  ).toBe("first();\r\nsecond");
});

test("an LSP position after a CRLF line's CR is refused, not applied to the CR", () => {
  const content = "first();\r\nsecond();\r\n";
  expect(() =>
    lspRangeMatch("/a.ts", createTextDocument("/a.ts", content), range(0, 0, 0, 9)),
  ).toThrow(expect.objectContaining({ code: SOURCE_CHANGED }));
});

test("LSP positions in a file with a lone CR are refused instead of guessed", () => {
  const content = "const s = 'a\rb';\nsame();\n";
  expect(() =>
    lspRangeMatch("/a.ts", createTextDocument("/a.ts", content), range(1, 0, 1, 4)),
  ).toThrow(expect.objectContaining({ code: "LSP_AMBIGUOUS_LINE_BREAK" }));
});
