import { expect, test } from "vitest";
import { TextChangeDocument, applyTextChanges } from "#src/core/text-change-engine.ts";

const cases = [
  { payload: "NEW", body: "NEW" },
  { payload: "NEW\n", body: "NEW" },
  { payload: "\nNEW", body: "NEW" },
  { payload: "NEW\n\n", body: "NEW\n" },
  { payload: "\nNEW\n", body: "NEW" },
];

for (const separator of ["\n", "\r\n"]) {
  for (const { payload, body } of cases) {
    for (const before of [false, true]) {
      for (const terminated of [false, true]) {
        test(`insertion boundaries (LPT-1747) ${JSON.stringify({ separator, payload, before, terminated })}`, () => {
          const source = ["FIRST", "ANCHOR"].join(separator) + (terminated ? separator : "");
          const normalized = payload.replace(/\n/g, separator);
          const inserted = body.replace(/\n/g, separator);
          const document = new TextChangeDocument(source);
          const change = document.insert(document.lineSpan(2, 2), normalized, { before });
          let expected: string;
          if (!payload.includes("\n")) {
            expected = before
              ? `FIRST${separator}${payload}ANCHOR${terminated ? separator : ""}`
              : `FIRST${separator}ANCHOR${payload}${terminated ? separator : ""}`;
          } else if (before) {
            expected = `FIRST${separator}${inserted}${separator}ANCHOR${terminated ? separator : ""}`;
          } else if (terminated) {
            // A file that ends with a line break keeps it after the inserted line.
            expected = `${source}${inserted}${separator}`;
          } else {
            expected = `${source}${separator}${inserted}`;
          }
          expect(applyTextChanges(source, [change]).content).toBe(expected);
        });
      }
    }
  }
}
