import { applyPatch, createTwoFilesPatch, diffLines } from "diff";
import { expect, test } from "vitest";

import {
  computeChangedRanges,
  createUnifiedDiff,
  diffTextLines,
} from "#src/core/mutation-result/diff.ts";

/** Small deterministic generator so failures reproduce. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

interface Case {
  readonly name: string;
  readonly before: string;
  readonly after: string;
}

function generatedCases(lineValue: (index: number) => string): Case[] {
  const cases: Case[] = [];
  const next = random(7);
  let fresh = 0;
  for (let index = 0; index < 400; index += 1) {
    const lineCount = Math.floor(next() * 30);
    const eol = next() < 0.3 ? "\r\n" : "\n";
    const lines = Array.from({ length: lineCount }, (_, line) => lineValue(line));
    const finalBreak = next() < 0.7;
    const after = [...lines];
    const edits = 1 + Math.floor(next() * 3);
    for (let edit = 0; edit < edits; edit += 1) {
      const at = Math.floor(next() * (after.length + 1));
      const kind = next();
      if (kind < 0.3) {
        after.splice(at, 0, `fresh ${(fresh += 1)}`);
      } else if (kind < 0.6 && after.length > 0) {
        after.splice(Math.min(at, after.length - 1), 1 + Math.floor(next() * 3));
      } else if (after.length > 0) {
        const target = Math.min(at, after.length - 1);
        after[target] = `${after[target]} edited ${(fresh += 1)}`;
      }
    }
    const afterFinalBreak = next() < 0.15 ? !finalBreak : finalBreak;
    const join = (value: readonly string[], trailing: boolean) =>
      value.join(eol) + (trailing && value.length > 0 ? eol : "");
    cases.push({
      name: `case ${index}`,
      before: join(lines, finalBreak),
      after: join(after, afterFinalBreak),
    });
  }
  return cases;
}

function referenceUnifiedDiff(before: string, after: string): string {
  return createTwoFilesPatch("file.ts", "file.ts", before, after, "", "", { context: 3 })
    .replace(/^(?:Index: .*\n)?={3,}\n?/m, "")
    .trimEnd();
}

function referenceStats(before: string, after: string) {
  const stats = { removed: 0, added: 0 };
  for (const part of diffLines(before, after)) {
    if (part.added) stats.added += part.count;
    if (part.removed) stats.removed += part.count;
  }
  return stats;
}

test("diffs only the changed lines but matches a whole-file diff of distinct lines", () => {
  for (const { name, before, after } of generatedCases((line) => `line ${line}`)) {
    expect(createUnifiedDiff("file.ts", before, after), name).toEqual({
      diff: referenceUnifiedDiff(before, after),
      stats: referenceStats(before, after),
    });
    expect(diffTextLines(before, after), name).toEqual(diffLines(before, after));
  }
});

test("produces an applicable diff for repeated lines", () => {
  for (const { name, before, after } of generatedCases((line) => `line ${line % 3}`)) {
    const result = createUnifiedDiff("file.ts", before, after);
    // jsdiff's applyPatch converts line endings, so only LF texts round-trip exactly.
    if (!`${before}${after}`.includes("\r")) {
      expect(applyPatch(before, result.diff), name).toBe(after);
    }
    const parts = diffTextLines(before, after);
    expect(
      parts
        .filter((part) => !part.added)
        .map((part) => part.value)
        .join(""),
      name,
    ).toBe(before);
    expect(
      parts
        .filter((part) => !part.removed)
        .map((part) => part.value)
        .join(""),
      name,
    ).toBe(after);
  }
});

test("reports changed ranges in the after file", () => {
  const before = Array.from({ length: 50 }, (_, line) => `line ${line}`).join("\n");
  const after = before.replace("line 10\n", "line 10\nnew\n").replace("line 40", "line 40 edited");
  expect(computeChangedRanges(before, after)).toEqual([
    { start: 12, end: 12 },
    { start: 42, end: 42 },
  ]);
});
