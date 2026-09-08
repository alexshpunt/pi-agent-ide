import { expect, test, vi } from "vitest";
import { lineDiff } from "diff";

import { FileMutationResult } from "pi-agent-text-editor/api/mutation-result";
import { resolveMutationResultResources } from "#src/mutation-result.js";
import { freezeMutationViewports, projectFinalResources } from "#src/frozen-viewport.js";
import { expandedViewport, compactViewport } from "#src/diff-viewport.js";
import { requiredValue } from "pi-agent-invariant";

const before =
  Array.from({ length: 30 }, (_, i) => `const value${i + 1} = ${i + 1};`).join("\n") + "\n";
const replacement = "const value10 = build(a, b, c, d);";
const generated = before.replace("const value10 = 10;", replacement);
const from = generated.indexOf("const value10");
const resource = {
  path: "example.ts",
  beforeContent: before,
  afterContent: generated,
  ranges: [{ from, to: from + replacement.length }],
};
const expandedCall = "const value10 = build(\n  a,\n  b,\n  c,\n  d,\n);";
const formatted = generated.replace(replacement, expandedCall);

function final(content: string) {
  return requiredValue(
    projectFinalResources(
      [{ ...resource, afterContent: content }],
      freezeMutationViewports([resource]),
    )[0]?.model,
  );
}

test("a growing local change retains its end without inventing removals of shifted context", () => {
  const model = final(formatted);
  const changed = model.rows.filter((row) => row.changed);
  expect(changed.map((row) => row.text).join("\n")).toBe(expandedCall);
  expect(model.removed).toBe(0);
  expect(model.rows.filter((row) => row.kind === "context").map((row) => row.text)).toContain(
    "const value11 = 11;",
  );
  expect(expandedViewport(model).map(({ row }) => row?.text)).toContain(");");
});

test("earlier post-processing insertions shift the local area and are explicitly omitted", () => {
  const model = final("// inserted first\n// inserted second\n" + formatted);
  expect(
    model.rows
      .filter((row) => row.changed)
      .map((row) => row.text)
      .join("\n"),
  ).toBe(expandedCall);
  expect(model.removed).toBe(0);
  expect(model.rows.find((row) => row.text === "const value10 = build(")?.afterLine).toBe(12);
  expect(model).toMatchObject({ omittedChanges: { outside: 2, ambiguous: 0 } });
});

test("distant changes stay outside the local area in expanded mode", () => {
  const model = final(formatted.replace("const value30 = 30;", "const value30 = distant();"));
  expect(model.rows.some((row) => row.text.includes("distant"))).toBe(false);
  expect(model).toMatchObject({ omittedChanges: { outside: 1, ambiguous: 0 } });
});

test("compact clips only presentation while expanded retains a tall local change", () => {
  const tall =
    "const value10 = build(\n" +
    Array.from({ length: 20 }, (_, i) => `  argument${i},`).join("\n") +
    "\n);";
  const model = final(generated.replace(replacement, tall));
  expect(
    model.rows
      .filter((row) => row.changed)
      .map((row) => row.text)
      .join("\n"),
  ).toBe(tall);
  expect(compactViewport(model)).toHaveLength(12);
  expect(expandedViewport(model)).toHaveLength(model.rows.length);
});

test("an unanchored whole-file rewrite is disclosed instead of claimed as the local edit", () => {
  const model = final(Array.from({ length: 30 }, (_, i) => `different ${i}`).join("\n") + "\n");
  expect(model.rows.filter((row) => row.changed)).toEqual([]);
  expect(model).toMatchObject({
    omittedChanges: { outside: 0, ambiguous: expect.any(Number) as unknown },
  });
});

test("earlier deletions preserve the complete local change at its shifted position", () => {
  const model = final(formatted.split("\n").slice(2).join("\n"));
  expect(model.rows.find((row) => row.text === "const value10 = build(")?.afterLine).toBe(8);
  expect(
    model.rows
      .filter((row) => row.changed)
      .map((row) => row.text)
      .join("\n"),
  ).toBe(expandedCall);
  expect(model.omittedChanges).toEqual({ outside: 2, ambiguous: 0 });
});

test("nearby batch windows do not claim a sibling's growing area", () => {
  const peerFrom = before.indexOf("const value12");
  const model = requiredValue(
    projectFinalResources(
      [
        {
          ...resource,
          afterContent: formatted.replace(
            "const value12 = 12;",
            "const value12 = peer(\n  one,\n  two,\n);",
          ),
          diffPeerRanges: [{ from: peerFrom, to: peerFrom + "const value12 = 12;".length }],
        },
      ],
      freezeMutationViewports([resource]),
    )[0]?.model,
  );
  expect(
    model.rows
      .filter((row) => row.changed)
      .map((row) => row.text)
      .join("\n"),
  ).toBe(expandedCall);
  expect(model.omittedChanges).toBeUndefined();
});

test("a shared batch hunk is disclosed rather than duplicated", () => {
  const peerFrom = before.indexOf("const value11");
  const model = requiredValue(
    projectFinalResources(
      [
        {
          ...resource,
          afterContent: formatted.replace("const value11 = 11;", "const value11 = peer();"),
          diffPeerRanges: [{ from: peerFrom, to: peerFrom + "const value11 = 11;".length }],
        },
      ],
      freezeMutationViewports([resource]),
    )[0]?.model,
  );
  expect(model.rows.filter((row) => row.changed).map((row) => row.text)).toEqual([
    "const value10 = build(",
  ]);
  expect(model.omittedChanges?.ambiguous).toBeGreaterThan(0);
});

test("an inserted local block keeps its growth and final line numbers", () => {
  const offset = before.indexOf("const value10");
  const inserted = "newCall();\n";
  const preview = {
    path: "example.ts",
    beforeContent: before,
    afterContent: before.slice(0, offset) + inserted + before.slice(offset),
    beforeRanges: [{ from: offset, to: offset }],
    ranges: [{ from: offset, to: offset + inserted.length }],
  };
  const after =
    "// header\n" + preview.afterContent.replace(inserted, "newCall(\n  first,\n  second,\n);\n");
  const model = requiredValue(
    projectFinalResources(
      [{ ...preview, afterContent: after }],
      freezeMutationViewports([preview]),
    )[0]?.model,
  );
  expect(model.rows.filter((row) => row.changed).map((row) => row.text)).toEqual([
    "newCall(",
    "  first,",
    "  second,",
    ");",
  ]);
  expect(model.omittedChanges).toEqual({ outside: 1, ambiguous: 0 });
});

test("adjacent batch edits retain their own reliable rows without postprocessing", () => {
  const peerFrom = before.indexOf("const value11");
  const model = requiredValue(
    resolveMutationResultResources(
      {
        results: [
          new FileMutationResult({
            ok: true,
            path: "example.ts",
            beforeContentMap: { "example.ts": before },
            afterContent: generated.replace("const value11 = 11;", "const value11 = peer();"),
            rawChanges: [
              {
                editIndex: 0,
                removedText: "const value10 = 10;",
                fromA: from,
                toA: from + "const value10 = 10;".length,
                fromB: from,
                toB: from + replacement.length,
                insertedText: replacement,
              },
            ],
            diffPeerRanges: [
              {
                from: peerFrom,
                to: peerFrom + "const value11 = 11;".length,
                insert: "const value11 = peer();",
              },
            ],
          }),
        ],
      },
      undefined,
    )[0]?.model,
  );
  expect(
    model.rows.filter((row) => row.changed && row.afterLine !== undefined).map((row) => row.text),
  ).toEqual([replacement]);
  expect(model.rows.filter((row) => row.kind === "removed").map((row) => row.text)).toEqual([
    "const value10 = 10;",
  ]);
  expect(model.omittedChanges).toBeUndefined();
});

test("compact omission counts include the rows replaced by indicators", () => {
  const model = final(
    generated.replace(
      replacement,
      "const value10 = build(\n" +
        Array.from({ length: 30 }, (_, i) => `  arg${i},`).join("\n") +
        "\n);",
    ),
  );
  const viewport = compactViewport(model);
  expect(
    viewport.reduce(
      (count, item) => count + (item.row?.changed ? 1 : 0) + (item.omittedChanged ?? 0),
      0,
    ),
  ).toBe(model.added + model.modified + model.removed);
});

test("alignment budget exhaustion is explicit without inventing counts", () => {
  const frozen = freezeMutationViewports([resource]);
  const diff = vi.spyOn(lineDiff, "diff").mockReturnValue([]);
  try {
    const model = requiredValue(
      projectFinalResources([{ ...resource, afterContent: formatted }], frozen)[0]?.model,
    );
    expect(model.omittedChanges).toEqual({ outside: 0, ambiguous: 0, unavailable: true });
    expect(model.rows).toEqual([]);
  } finally {
    diff.mockRestore();
  }
});

test("separate insertion windows retain separate original anchors", () => {
  const generated = before
    .replace("const value5", "firstCall();\nconst value5")
    .replace("const value20", "secondCall();\nconst value20");
  const preview = {
    path: "example.ts",
    beforeContent: before,
    afterContent: generated,
    beforeRanges: [5, 20].map((n) => {
      const from = before.indexOf(`const value${n} `);
      return { from, to: from };
    }),
    ranges: ["firstCall();", "secondCall();"].map((text) => {
      const from = generated.indexOf(text);
      return { from, to: from + text.length };
    }),
  };
  const after = generated
    .replace("firstCall();", "firstCall(\n  first,\n);")
    .replace("secondCall();", "secondCall(\n  second,\n);");
  const model = requiredValue(
    projectFinalResources(
      [{ ...preview, afterContent: after }],
      freezeMutationViewports([preview]),
    )[0]?.model,
  );
  expect(model.rows.filter((row) => row.changed).map((row) => row.text)).toEqual([
    "firstCall(",
    "  first,",
    ");",
    "secondCall(",
    "  second,",
    ");",
  ]);
  expect(model.omittedChanges).toBeUndefined();
});
