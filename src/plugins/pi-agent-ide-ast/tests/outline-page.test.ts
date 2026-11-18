import type { SourceViewBlock } from "pi-agent-ide/api/code-view";
import { expect, test } from "vitest";
import { pageOutline, validateOutlineSnapshot } from "#src/outline-page.ts";

function sourceRow(text: string, lineNumber: number) {
  return { text, sourceLine: { source: "/fixture.ts", content: text, lineNumber } };
}

function outline(rows: SourceViewBlock["renderedLines"]) {
  return { path: "fixture.ts", startLine: 1, endLine: 120, totalLines: 120, renderedLines: rows };
}

test("outline page stops before a row that cannot fit in the remaining UTF-8 budget", () => {
  const first = sourceRow("é".repeat(4_000), 4);
  const next = sourceRow("é".repeat(4_000), 80);
  const full = outline([first, next]);
  const page = pageOutline(full, full.path, {});
  expect(page).toMatchObject({ startLine: 4, endLine: 4, renderedLines: [first] });
  expect(page.warning).toContain(JSON.stringify({ path: full.path, offset: 2, limit: 100 }));
  expect(pageOutline(full, full.path, { offset: 2 })).toMatchObject({
    startLine: 80,
    endLine: 80,
    renderedLines: [next],
  });
});

test("an oversized projected row is not source-mapped and does not block following declarations", () => {
  const next = sourceRow("declare const keep: number;", 80);
  const full = outline([sourceRow("é".repeat(7_000), 4), next]);
  const page = pageOutline(full, full.path, {});
  expect(page.renderedLines.map((row) => row.sourceLine)).toEqual([undefined, next.sourceLine]);
  expect(page.endLine).toBe(80);
  expect(() => pageOutline(full, full.path, { offset: 3 })).toThrow(Error);
});

test("unmapped blank projection rows do not fill an outline page", () => {
  const first = sourceRow("declare const first: number;", 1);
  const next = sourceRow("declare const next: number;", 120);
  const full = outline([first, ...Array.from({ length: 118 }, () => ({ text: "" })), next]);
  expect(pageOutline(full, full.path, { limit: 1 }).renderedLines).toEqual([first]);
  expect(pageOutline(full, full.path, { offset: 2 }).renderedLines).toEqual([next]);
});

test("outline input rejects overly large snapshots by either bytes or lines", () => {
  expect(() => validateOutlineSnapshot(["é".repeat(2_097_153)], "fixture.ts")).toThrow(Error);
  expect(() =>
    validateOutlineSnapshot(
      Array.from({ length: 100_001 }, () => ""),
      "fixture.ts",
    ),
  ).toThrow(Error);
});
