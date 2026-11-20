import { expect, test } from "vitest";
import { TextChangeDocument, applyTextChanges } from "#src/core/text-change-engine.ts";

for (const separator of ["\n", "\r\n"]) {
  for (const payload of ["NEW", "NEW\n", "\nNEW", "NEW\n\n", "\nNEW\n"]) {
    for (const before of [false, true]) {
      for (const terminated of [false, true]) {
        test(`insertion boundaries (LPT-1747) ${JSON.stringify({ separator, payload, before, terminated })}`, () => {
          const source = ["FIRST", "ANCHOR"].join(separator) + (terminated ? separator : "");
          const normalized = payload.replace(/\n/g, separator);
          const document = new TextChangeDocument(source);
          const change = document.insert(document.lineSpan(2, 2), normalized, { before });
          let expected: string;
          if (!payload.includes("\n")) {
            expected = before
              ? `FIRST${separator}${payload}ANCHOR${terminated ? separator : ""}`
              : `${source.slice(0, source.length - (terminated ? separator.length : 0))}${payload}${terminated ? separator : ""}`;
          } else if (before) {
            expected = `FIRST${separator}${normalized}${normalized.endsWith(separator) ? "" : separator}ANCHOR${terminated ? separator : ""}`;
          } else if (terminated) {
            // A file that ends with a line break keeps it after the inserted line.
            expected = `${source}${normalized}${normalized.endsWith(separator) ? "" : separator}`;
          } else {
            const body = normalized.endsWith(separator)
              ? normalized.slice(0, -separator.length)
              : normalized;
            expected = `${source}${separator}${body}`;
          }
          expect(applyTextChanges(source, [change]).content).toBe(expected);
        });
      }
    }
  }
}
