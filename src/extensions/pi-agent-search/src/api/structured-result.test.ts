import { expect, test } from "vitest";
import { selectionData, selectionPreview } from "./structured-result.ts";

const match = (index: number, text = `m${String(index)}`) => ({
  source: "/workspace/a.txt",
  lineNumber: index + 1,
  startColumn: 0,
  endColumn: text.length,
  matchedText: text,
});

test("selection data keeps every match with its whole text", () => {
  const long = "x".repeat(10_000);
  const data = selectionData(
    [...Array.from({ length: 150 }, (_, index) => match(index)), match(150, long)],
    true,
    "AB12",
  );
  expect(data.matches).toHaveLength(151);
  expect(data.matches[150]?.matchedText).toBe(long);
  expect(data.matches[150]?.references?.match).toBe("SEARCH#AB12:151:match");
  expect(data).not.toHaveProperty("truncated");
});

test("a preview keeps the first 100 matches and only texts up to 4 KB", () => {
  const data = selectionData(
    [match(0, "y".repeat(5000)), ...Array.from({ length: 150 }, (_, index) => match(index + 1))],
    true,
  );
  const preview = selectionPreview(data) as typeof data & { truncated?: boolean };
  expect(preview.truncated).toBe(true);
  expect(preview.complete).toBe(true);
  expect(preview.matches).toHaveLength(100);
  expect(preview.matches[0]).not.toHaveProperty("matchedText");
  expect(preview.matches[0]).toMatchObject({ textTruncated: true });
  expect(preview.matches[1]?.matchedText).toBe("m1");
});

test("a preview cuts long capture texts and leaves short lists and other data alone", () => {
  const capture = { ...selectionData([match(0, "z".repeat(5000))], true).matches[0] };
  const data = {
    ...selectionData([match(0)], true),
    matches: [{ ...selectionData([match(0)], true).matches[0], captures: { BODY: [capture] } }],
  };
  const preview = selectionPreview(data) as typeof data;
  expect(preview).not.toHaveProperty("truncated");
  expect(preview.matches[0]?.captures.BODY[0]).toMatchObject({ textTruncated: true });
  expect(preview.matches[0]?.captures.BODY[0]).not.toHaveProperty("matchedText");
  const files = { kind: "files", files: ["a.txt"], complete: true };
  expect(selectionPreview(files)).toBe(files);
});

test("a preview of a resolver's own value cuts each list of matches it holds", () => {
  const list = selectionData(
    Array.from({ length: 150 }, (_, index) => match(index)),
    true,
  );
  const graph = {
    kind: "custom",
    resolverId: "lsp",
    value: { target: "RESULT#a", incoming: list },
  };
  const preview = selectionPreview(graph) as typeof graph;
  expect(preview.value.target).toBe("RESULT#a");
  expect(preview.value.incoming).toMatchObject({ truncated: true });
  expect(preview.value.incoming.matches).toHaveLength(100);
});
