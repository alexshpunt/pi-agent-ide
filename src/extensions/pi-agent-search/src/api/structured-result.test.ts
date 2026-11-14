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

test("selection data includes available line context without inventing it", () => {
  const lineText = "prefix flags | MASK; // marker";
  const data = selectionData(
    [
      { ...match(0, "flags | MASK"), lineText },
      {
        ...match(1, "first\nlast"),
        endLineNumber: 2,
        lineText: "prefix first",
        linesText: "prefix first\nlast suffix",
      },
      match(2),
      { ...match(3), endLineNumber: 5, lineText: "first line only" },
    ],
    true,
  );
  expect(data.matches[0]).toMatchObject({ matchedText: "flags | MASK", lineText });
  expect(data.matches[1]).toMatchObject({ lineText: "prefix first\nlast suffix" });
  expect(data.matches[2]).not.toHaveProperty("lineText");
  expect(data.matches[3]).not.toHaveProperty("lineText");
});

test("previews bound line context in UTF-8 bytes independently of match text", () => {
  const lineText = "界".repeat(2000);
  const data = selectionData([{ ...match(0, "界"), lineText }], true);
  expect(data.matches[0]).toMatchObject({ matchedText: "界", lineText });
  const preview = selectionPreview(data) as typeof data;
  expect(preview.matches[0]).toMatchObject({ matchedText: "界", textTruncated: true });
  expect(preview.matches[0]).not.toHaveProperty("lineText");
});

test("line-context previews retain the 4 KB boundary and stay within the structured budget", () => {
  const boundary = "界".repeat(1365) + "x";
  const data = selectionData(
    Array.from({ length: 101 }, (_, index) => ({
      ...match(index, boundary),
      lineText: boundary,
    })),
    true,
  );
  const preview = selectionPreview(data) as typeof data;
  expect(preview.matches).toHaveLength(100);
  expect(preview.matches[0]).toMatchObject({ matchedText: boundary, lineText: boundary });
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(1024 * 1024);
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
