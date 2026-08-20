import { createTextDocument, renderPresentedTextDocument, renderTextDocument } from "pi-agent-text";
import { expect, test } from "vitest";

test("preserves line endings and renders line presentation separately", () => {
  const document = createTextDocument("notes.txt", "alpha\r\nbravo\n");
  const presented = {
    ...document,
    lines: document.lines.map((line) => ({
      ...line,
      presentation: { prefix: `${line.lineNumber}|`, suffix: "!" },
    })),
  };

  expect(document.lines).toMatchObject([
    { lineNumber: 1, content: "alpha", lineEnding: "\r\n" },
    { lineNumber: 2, content: "bravo", lineEnding: "\n" },
  ]);
  expect(renderTextDocument(presented)).toBe("alpha\r\nbravo\n");
  expect(renderPresentedTextDocument(presented)).toBe("1|alpha!\r\n2|bravo!\n");
});

test("aligns change markers, presented prefixes, and synthetic rows", () => {
  const document = createTextDocument("source.ts", "new value\ncontext\n");
  const presented = {
    ...document,
    lines: document.lines.map((line) =>
      line.lineNumber === 1
        ? {
            ...line,
            presentation: {
              prefix: " 1#AAAA|",
              marker: "+" as const,
              before: [{ marker: "-" as const, prefix: "|", content: "old value" }],
              suffix: "  <!-- change -->",
            },
          }
        : { ...line, presentation: { prefix: " 2#BBBB|" } },
    ),
  };

  expect(renderPresentedTextDocument(presented)).toBe(
    ["-|       |old value", "+| 1#AAAA|new value  <!-- change -->", " | 2#BBBB|context", ""].join(
      "\n",
    ),
  );
});
