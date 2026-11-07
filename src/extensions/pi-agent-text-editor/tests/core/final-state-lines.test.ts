import { expect, test } from "vitest";

import { FileMutationResult } from "#src/api/mutation-result.js";
import {
  finalStateLineNumbers,
  renderFinalStateFragment,
} from "#src/core/mutation-result/final-state-fragment.js";

const before = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
const after = before.replace("line 50", "changed 50");
const from = before.indexOf("line 50");
const rawChanges = [
  {
    editIndex: 0,
    fromA: from,
    toA: from + "line 50".length,
    fromB: from,
    toB: from + "changed 50".length,
    removedText: "line 50",
    insertedText: "changed 50",
  },
];
const hint = {
  file: "notes.txt",
  line: 90,
  column: 1,
  severity: "error",
  source: "compiler",
  code: "E1",
  message: "broken",
} as const;

test("selects every line the final-state fragment shows", () => {
  const result = new FileMutationResult({
    ok: true,
    path: "notes.txt",
    diffs: ["--- notes.txt"],
    beforeContentMap: { "notes.txt": before },
    afterContent: after,
    rawChanges,
    hints: [hint],
  });
  const shown = renderFinalStateFragment(result, "notes.txt")
    .flatMap((line) => /^Final text, lines (\d+)–(\d+):$/u.exec(line) ?? [])
    .filter((_, index) => index % 3 !== 0)
    .map(Number);

  expect(shown).toEqual([45, 55, 85, 95]);
  expect(finalStateLineNumbers({ before, after, rawChanges, hints: [hint] })).toEqual([
    ...Array.from({ length: 11 }, (_, index) => 45 + index),
    ...Array.from({ length: 11 }, (_, index) => 85 + index),
  ]);
});
