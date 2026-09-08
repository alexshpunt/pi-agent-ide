import { expect, test } from "vitest";
import { TextChangeDocument, applyTextChanges } from "#src/core/text-change-engine.js";

for (const separator of ["\n", "\r\n"]) {
  for (const payload of ["NEW", "NEW\n", "\nNEW", "NEW\n\n", "\nNEW\n"]) {
    for (const before of [false, true]) {
      for (const terminated of [false, true]) {
        test(`insertion boundaries ${JSON.stringify({ separator, payload, before, terminated })}`, () => {
          const source = ["FIRST", "ANCHOR"].join(separator) + (terminated ? separator : "");
          const normalized = payload.replace(/\n/g, separator);
          const document = new TextChangeDocument(source);
          const change = before
            ? document.insertBeforeLine(2, normalized)
            : document.insertAfterLine(2, normalized);
          let expected: string;
          if (before) {
            expected = `FIRST${separator}${normalized}${normalized.endsWith(separator) ? "" : separator}ANCHOR${terminated ? separator : ""}`;
          } else if (terminated) {
            expected = `${source}${normalized}${normalized.endsWith(separator) ? "" : separator}`;
          } else {
            expected = `${source}${separator}${normalized.endsWith(separator) ? normalized.slice(0, -separator.length) : normalized}`;
          }
          expect(applyTextChanges(source, [change]).content).toBe(expected);
        });
      }
    }
  }
}
