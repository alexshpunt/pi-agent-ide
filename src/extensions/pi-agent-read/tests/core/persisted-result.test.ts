import { expect, test } from "vitest";
import { createTextDocument } from "pi-agent-text";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { compactReadDetails, restoreReadDetails } from "#src/core/tools/read/persisted-result.js";

test("restores read lines, annotations and truncation from saved output alone", () => {
  const content = "a long original source line with Unicode 🍀\r\nsecond line\r\n";
  const lines = createTextDocument("fixture.ts", content).lines.map((line) => ({
    ...line,
    presentation: { prefix: "ANCHOR ", compactPrefix: "1 " },
    metadata: { source: "fixture.ts" },
  }));
  const text = lines.map((line) => `ANCHOR ${line.content}${line.lineEnding}`).join("");
  const details = { source: "fixture.ts", lines, truncation: truncateHead(text, { maxLines: 1 }) };
  const stored = JSON.parse(JSON.stringify(compactReadDetails(details, text))) as ReturnType<
    typeof compactReadDetails
  >;
  expect(restoreReadDetails(stored, text)).toEqual(details);
  expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(details).length);
});

test("keeps literal text when an annotation or truncation removes it from output", () => {
  const details = {
    lines: createTextDocument("fixture.txt", "text absent from returned output\n").lines,
  };
  const stored = JSON.parse(JSON.stringify(compactReadDetails(details, "truncated"))) as ReturnType<
    typeof compactReadDetails
  >;
  expect(restoreReadDetails(stored, "truncated")).toEqual(details);
});
