import { expect, test } from "vitest";
import { compactSearchDetails, restoreSearchDetails } from "./persisted-result.js";

test("restores highlighted search geometry and literal delimiter characters exactly", () => {
  const line = "a long original line with the needle and 🍀";
  const details = {
    query: "needle",
    matchCount: 2,
    fileCount: 1,
    complete: true,
    files: [
      {
        path: "fixture.txt",
        link: "file:///fixture.txt",
        matchCount: 2,
        lines: [
          { lineNumber: 1, text: line, matchCount: 1, ranges: [{ from: 30, to: 36 }] },
          {
            lineNumber: 2,
            text: "literal ⟦needle⟧ source characters",
            matchCount: 1,
            ranges: [{ from: 9, to: 15 }],
          },
        ],
      },
    ],
  };
  const text = `${line.replace("needle", "⟦needle⟧")}\nliteral ⟦⟦needle⟧⟧ source characters`;
  const stored = JSON.parse(JSON.stringify(compactSearchDetails(details, text))) as ReturnType<
    typeof compactSearchDetails
  >;
  expect(restoreSearchDetails(stored, text)).toEqual(details);
  expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(details).length);
});
