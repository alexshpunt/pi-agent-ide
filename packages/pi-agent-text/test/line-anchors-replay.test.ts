import { describe, expect, test } from "vitest";

import { lineAnchors } from "#src/line-anchors.ts";

/**
 * Replays random moves of top-level blocks in a C++-like file, as concurrent agents make them,
 * and checks every token issued before a move against the text after it.
 */

interface Line {
  readonly id: number;
  readonly text: string;
  readonly block?: number;
}

/** A small deterministic generator, so a failure replays the same moves. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Kinds of top-level blocks; repeated lines inside a block take its own unique lines as landmarks. */
const blockKinds: readonly ((index: number) => string[])[] = [
  (index) => [
    "template <typename T>",
    `T step${index}(T value) {`,
    "  if (value) {",
    `    value = next${index}(value);`,
    "  }",
    "  return value;",
    "}",
  ],
  (index) => [`struct Data${index} {`, "  int count = 0;", "  bool ready = false;", "};"],
  (index) => [`// Helper ${index}.`, `inline int helper${index}(int x) {`, "  return x;", "}"],
  (index) => ["template <typename T>", `struct Box${index} {`, "  T value;", "};"],
];

function sourceFile(blocks: number, next: () => number): Line[] {
  let id = 0;
  const line = (text: string, block?: number): Line => ({ id: id++, text, block });
  const lines = [line("#include <vector>"), line("")];
  for (let index = 0; index < blocks; index += 1) {
    const kind = blockKinds[Math.floor(next() * blockKinds.length)] as (index: number) => string[];
    lines.push(...kind(index).map((text) => line(text, index)));
    lines.push(line(""));
  }
  lines.push(line("// end"));
  return lines;
}

/** Moves one block with the blank line after it before another block; the blank there is new. */
function moveBlock(lines: readonly Line[], next: () => number, freshId: number): Line[] {
  const blocks = [
    ...new Set(lines.flatMap((line) => (line.block === undefined ? [] : [line.block]))),
  ];
  const moved = blocks[Math.floor(next() * blocks.length)];
  // Moving a block before the block that already follows it would change nothing.
  const following = blocks[blocks.indexOf(moved as number) + 1];
  const others = blocks.filter((block) => block !== moved && block !== following);
  const target = others[Math.floor(next() * others.length)];
  const body = lines.filter((line) => line.block === moved);
  const from = lines.indexOf(body[0] as Line);
  const rest = [...lines.slice(0, from), ...lines.slice(from + body.length + 1)];
  const at = rest.findIndex((line) => line.block === target);
  return [...rest.slice(0, at), ...body, { id: freshId, text: "" }, ...rest.slice(at)];
}

type Outcome = "same" | "stale" | "ambiguous" | "wrong";

function replay(seed: number, moves: number): Map<string, Map<Outcome, number>> {
  const next = random(seed);
  let lines = sourceFile(80, next);
  let freshId = 1_000_000;
  const counts = new Map<string, Map<Outcome, number>>();
  const count = (kind: string, outcome: Outcome) => {
    const byOutcome = counts.get(kind) ?? new Map<Outcome, number>();
    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
    counts.set(kind, byOutcome);
  };
  for (let move = 0; move < moves; move += 1) {
    const before = lineAnchors(lines.map((line) => line.text));
    const after = moveBlock(lines, next, freshId);
    freshId += 1;
    const afterAnchors = lineAnchors(after.map((line) => line.text));
    const positions = new Map(after.map((line, index) => [line.id, index + 1]));
    // The answer of linesWithAnchor for every token, without a scan of the file per line.
    const lineNumbers = new Map<string, number[]>();
    afterAnchors.forEach((anchor, index) => {
      lineNumbers.set(anchor, [...(lineNumbers.get(anchor) ?? []), index + 1]);
    });
    lines.forEach((line, index) => {
      const found = lineNumbers.get(before[index] as string) ?? [];
      const outcome: Outcome =
        found.length === 0
          ? "stale"
          : found.length > 1
            ? "ambiguous"
            : found[0] === positions.get(line.id)
              ? "same"
              : "wrong";
      count(line.text.trim() === "" ? "blank" : line.text, outcome);
    });
    lines = after;
  }
  return counts;
}

describe("line anchors under block moves", () => {
  test.each([1, 2, 3])("never name another line, and keep block boundaries (seed %i)", (seed) => {
    const counts = replay(seed, 150);
    const failures = [...counts].flatMap(([kind, byOutcome]) =>
      [...byOutcome].flatMap(([outcome, times]) =>
        outcome === "wrong" || (outcome !== "same" && kind !== "blank")
          ? [`${kind}: ${outcome} ${times}`]
          : [],
      ),
    );
    expect(failures).toEqual([]);
  });
});
