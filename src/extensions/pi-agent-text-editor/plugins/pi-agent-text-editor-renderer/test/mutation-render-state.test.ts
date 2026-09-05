import { requiredValue } from "pi-agent-invariant";

import { FileMutationResult } from "pi-agent-text-editor/api/mutation-result";
import { describe, expect, test } from "vitest";

import { freezeMutationViewports, projectFinalResources } from "#src/frozen-viewport.js";

import { resolveMutationResultResources } from "#src/mutation-result.js";
import {
  advanceTypingProjectionResources,
  preserveCompletedTypingRows,
  projectTypingResources,
} from "#src/mutation-projection.js";

import type { TextMutationPreviewResource } from "pi-agent-text-editor/api/mutation-preview";

describe("text mutation render state", () => {
  test("renders only written replacement lines and keeps the cursor before the implicit line break", () => {
    const beforeContent = [
      "export function loadConfig() {",
      "    const endpoint = readEndpoint();",
      "    const retries = readRetries();",
      "    const timeout = readTimeout();",
      "    return { endpoint, retries, timeout };",
      "}",
    ].join("\n");
    const selected =
      ["    const retries = readRetries();", "    const timeout = readTimeout();"].join("\n") +
      "\n";
    const generated = ["    const retries = readRetries();", "    const timeoutMs"].join("\n");
    const from = beforeContent.indexOf(selected);
    const inserted = `${generated}\n`;
    const afterContent =
      beforeContent.slice(0, from) + inserted + beforeContent.slice(from + selected.length);
    const resource: TextMutationPreviewResource = {
      path: "config.ts",
      beforeRanges: [{ from, to: from + selected.length }],
      ranges: [{ from, to: from + inserted.length }],
      beforeContent,
      afterContent,
    };

    const [typing] = projectTypingResources([resource], generated);
    const rows = typing?.model?.rows ?? [];

    expect(typing?.afterContent).toBe(afterContent);
    expect(typing?.afterContent).not.toContain("readTimeout();");
    expect(typing?.cursorOffset).toBe(from + generated.length);
    expect(typing?.afterContent.slice(typing.cursorOffset)).toMatch(/^\n    return/u);
    expect(rows.find(({ text }) => text.includes("readRetries"))?.kind).toBe("context");
    expect(rows.find(({ text }) => text.includes("timeoutMs"))?.kind).toBe("modified");
    expect(rows.some(({ kind }) => kind === "added" || kind === "removed")).toBe(false);
    expect(typing?.model).toMatchObject({ added: 0, modified: 1, removed: 0 });
  });

  test("treats completed full-file typing lines with edge-only whitespace changes as context", () => {
    const beforeContent = "function run() {\n  execute();  \n}";
    const afterContent = "function run() {\n    execute();\n}";
    const resource: TextMutationPreviewResource = {
      path: "worker.ts",
      beforeRanges: [{ from: 0, to: beforeContent.length }],
      ranges: [{ from: 0, to: afterContent.length }],
      beforeContent,
      afterContent,
    };

    const [typing] = projectTypingResources([resource], afterContent);
    const execute = typing?.model?.rows.find(({ text }) => text.includes("execute"));

    expect(typing?.afterContent).toBe(afterContent);
    expect(typing?.cursorOffset).toBe(afterContent.length);
    expect(execute?.kind).toBe("context");
    expect(typing?.model).toMatchObject({ added: 0, modified: 0, removed: 0 });

    const changedAfterContent = "function run() {\n    execute(2);  \n}";
    const changedResource: TextMutationPreviewResource = {
      ...resource,
      ranges: [{ from: 0, to: changedAfterContent.length }],
      afterContent: changedAfterContent,
    };
    const [changedTyping] = projectTypingResources([changedResource], changedAfterContent);
    const changedExecute = changedTyping?.model?.rows.find(({ text }) => text.includes("execute"));

    expect(changedExecute).toMatchObject({
      kind: "modified",
      addedRanges: [{ from: 4, to: 15 }],
    });

    const previousVisible = "function run() {\n";
    const nextVisible = `${previousVisible}    exec`;
    const previousTyping = projectTypingResources(
      [changedResource],
      changedAfterContent,
      previousVisible,
    );
    const advanced = advanceTypingProjectionResources(
      [changedResource],
      changedAfterContent,
      previousTyping,
      previousVisible,
      nextVisible,
    );
    const advancedExecute = advanced?.[0]?.model?.rows.find(({ text }) => text.includes("exec"));

    expect(advancedExecute).toMatchObject({
      kind: "modified",
      addedRanges: [{ from: 4, to: 8 }],
    });
  });

  test("keeps the generated viewport while rendering the actual final file", () => {
    const beforeLines = Array.from(
      { length: 30 },
      (_, index) => `const value${index + 1} = ${index + 1};`,
    );
    const generatedLines = [...beforeLines];
    generatedLines[19] = "const value20 = computeValue();";
    const beforeContent = beforeLines.join("\n");
    const generatedContent = generatedLines.join("\n");
    const generatedFrom = generatedContent.indexOf(generatedLines[19]);
    const preview: TextMutationPreviewResource = {
      path: "stable.ts",
      beforeRanges: [
        {
          from: beforeContent.indexOf(requiredValue(beforeLines[19])),
          to:
            beforeContent.indexOf(requiredValue(beforeLines[19])) +
            requiredValue(beforeLines[19]).length,
        },
      ],
      ranges: [{ from: generatedFrom, to: generatedFrom + generatedLines[19].length }],
      beforeContent,
      afterContent: generatedContent,
    };
    const frozen = freezeMutationViewports([preview]);
    const finalLines = [...generatedLines];
    finalLines[0] = "// formatter changed a distant line";
    finalLines[18] = "const value19 = formattedContext();";
    const finalContent = finalLines.join("\n");
    const [resource] = projectFinalResources(
      [{ ...preview, ranges: [], afterContent: finalContent }],
      frozen,
    );

    const model = resource?.model;

    if (model === undefined) {
      throw new Error("Expected a final viewport model");
    }

    expect(model).toMatchObject({ added: 0, modified: 2, removed: 0 });
    expect(model.rows.map(({ afterLine }) => afterLine).filter(Boolean)).toEqual([
      18, 19, 20, 21, 22,
    ]);
    expect(model.rows.map(({ text }) => text)).toContain("const value19 = formattedContext();");
    expect(model.rows.map(({ text }) => text)).not.toContain("// formatter changed a distant line");
  });

  test.each([
    ["LF", ["alpha", "beta", "gamma"].join("\n") + "\n"],
    ["CRLF", ["alpha", "beta", "gamma"].join("\r\n") + "\r\n"],
    ["empty lines", "alpha\n\n beta\n"],
  ])("TS-01 preserves rows while appending across %s boundaries", (_name, generated) => {
    const resource: TextMutationPreviewResource = {
      path: "streamed.txt",
      beforeRanges: [{ from: 0, to: 0 }],
      ranges: [{ from: 0, to: generated.length }],
      beforeContent: "",
      afterContent: generated,
    };
    let visible = generated.slice(0, 1);
    let current = requiredValue(projectTypingResources([resource], generated, visible)[0]);
    const retained = new Map<number, object>();

    for (const boundary of appendBoundaries(generated).slice(1)) {
      const nextVisible = generated.slice(0, boundary);
      const advanced = advanceTypingProjectionResources(
        [resource],
        generated,
        [current],
        visible,
        nextVisible,
      );
      expect(advanced, `append ending at ${JSON.stringify(nextVisible)}`).toBeDefined();
      current = requiredValue(
        (advanced ?? projectTypingResources([resource], generated, nextVisible))[0],
      );
      const fresh = requiredValue(projectTypingResources([resource], generated, nextVisible)[0]);
      expect(snapshot(current)).toEqual(snapshot(fresh));

      const cursorLine = lineNumber(nextVisible);
      for (const row of current.model?.rows ?? []) {
        if (row.afterLine !== undefined && row.afterLine < cursorLine) {
          const prior = retained.get(row.afterLine);
          if (prior !== undefined) {
            expect(row).toBe(prior);
          } else {
            retained.set(row.afterLine, row);
          }
        }
      }
      visible = nextVisible;
    }
  });

  test("TS-01 keeps empty content correct without an incremental row", () => {
    const resource: TextMutationPreviewResource = {
      path: "empty.txt",
      beforeRanges: [{ from: 0, to: 0 }],
      ranges: [{ from: 0, to: 0 }],
      beforeContent: "",
      afterContent: "",
    };
    const [projected] = projectTypingResources([resource], "", "");

    expect(projected?.afterContent).toBe("");
    expect(projected?.cursorOffset).toBe(0);
    expect(projected?.model?.rows).toEqual([]);
    expect(projected?.model).toMatchObject({ added: 0, modified: 0, removed: 0 });
  });

  test("TS-01 keeps multiple resources on the safe full path", () => {
    const generated = "alpha";
    const resource = (path: string): TextMutationPreviewResource => ({
      path,
      beforeRanges: [{ from: 0, to: 0 }],
      ranges: [{ from: 0, to: generated.length }],
      beforeContent: "",
      afterContent: generated,
    });
    const resources = [resource("first.txt"), resource("second.txt")];
    const previous = projectTypingResources(resources, generated, "");
    const advanced = advanceTypingProjectionResources(
      resources,
      generated,
      previous,
      "",
      generated,
    );
    const fresh = projectTypingResources(resources, generated, generated);

    expect(advanced).toBeUndefined();
    expect(
      fresh.map(({ path, beforeContent, afterContent, cursorOffset, model }) => ({
        path,
        beforeContent,
        afterContent,
        cursorOffset,
        model: model && {
          rows: model.rows.map(({ kind, text, beforeLine, afterLine, changed, addedRanges }) => ({
            kind,
            text,
            beforeLine,
            afterLine,
            changed,
            addedRanges,
          })),
          added: model.added,
          modified: model.modified,
          removed: model.removed,
          focusRow: model.focusRow,
        },
      })),
    ).toEqual([
      {
        path: "first.txt",
        beforeContent: "",
        afterContent: "alpha",
        cursorOffset: 5,
        model: {
          rows: [
            {
              kind: "added",
              text: "alpha",
              beforeLine: undefined,
              afterLine: 1,
              changed: true,
              addedRanges: [{ from: 0, to: 5 }],
            },
          ],
          added: 1,
          modified: 0,
          removed: 0,
          focusRow: 0,
        },
      },
      {
        path: "second.txt",
        beforeContent: "",
        afterContent: "alpha",
        cursorOffset: 5,
        model: {
          rows: [
            {
              kind: "added",
              text: "alpha",
              beforeLine: undefined,
              afterLine: 1,
              changed: true,
              addedRanges: [{ from: 0, to: 5 }],
            },
          ],
          added: 1,
          modified: 0,
          removed: 0,
          focusRow: 0,
        },
      },
    ]);
  });

  test("keeps reordered replacement rows stable through fallback projection", () => {
    const originalLines = [
      "const item = loadFirst();",
      "const item = loadSecond();",
      "const item = loadThird();",
    ];
    const replacementLines = [
      "const item = loadSecond();",
      "const item = loadSecondAgain();",
      "const item = loadFirst();",
    ];
    const beforeContent = ["head", ...originalLines, "tail"].join("\n");
    const selected = originalLines.join("\n");
    const generated = replacementLines.join("\n");
    const from = beforeContent.indexOf(selected);
    const resourceFor = (replacement: string): TextMutationPreviewResource => ({
      path: "reordered.ts",
      beforeRanges: [{ from, to: from + selected.length }],
      ranges: [{ from, to: from + replacement.length }],
      beforeContent,
      afterContent:
        beforeContent.slice(0, from) + replacement + beforeContent.slice(from + selected.length),
    });
    const previousGenerated =
      "const item = loadSecond();\nconst item = loadSecondAgain();\nconst item ";
    const nextGenerated = `${previousGenerated}=`;
    const previous = projectTypingResources(
      [resourceFor(previousGenerated)],
      previousGenerated,
      previousGenerated,
    );
    const fresh = projectTypingResources(
      [resourceFor(nextGenerated)],
      nextGenerated,
      nextGenerated,
    );
    const previousRow = previous[0]?.model?.rows.find(
      (row) => row.text === "const item = loadSecondAgain();",
    );
    const freshRow = fresh[0]?.model?.rows.find(
      (row) => row.text === "const item = loadSecondAgain();",
    );
    expect(previousRow?.kind).not.toBe(freshRow?.kind);

    const [preserved] = preserveCompletedTypingRows(previous, fresh);

    expect(
      preserved?.model?.rows.find((row) => row.text === "const item = loadSecondAgain();"),
    ).toBe(previousRow);

    const finalResource = resourceFor(generated);
    const finalFresh = resolveMutationResultResources(
      {
        results: [
          new FileMutationResult({
            ok: true,
            path: finalResource.path,
            files: [{ path: finalResource.path, action: "edited" }],
            beforeContentMap: { [finalResource.path]: beforeContent },
            afterContent: finalResource.afterContent,
            rawChanges: [
              {
                editIndex: 0,
                removedText: selected,
                fromA: from,
                toA: from + selected.length,
                fromB: from,
                toB: from + generated.length,
                insertedText: generated,
              },
            ],
          }),
        ],
      },
      freezeMutationViewports([requiredValue(preserved)]),
    );
    expect(finalFresh[0]).toMatchObject({ ranges: [], typingIdentity: { ranges: [{ from }] } });
    const [finalPreserved] = preserveCompletedTypingRows([requiredValue(preserved)], finalFresh);
    expect(
      finalPreserved?.model?.rows.find((row) => row.text === "const item = loadSecondAgain();"),
    ).toBe(previousRow);

    const retargeted = [
      { ...requiredValue(fresh[0]), ranges: [{ from: from + 1, to: from + generated.length }] },
    ];
    const [unpreserved] = preserveCompletedTypingRows(previous, retargeted);
    expect(
      unpreserved?.model?.rows.find((row) => row.text === "const item = loadSecondAgain();"),
    ).toBe(freshRow);
  });

  test("TS-01 keeps rewind and non-prefix updates on the safe full path", () => {
    const resource: TextMutationPreviewResource = {
      path: "rewind.txt",
      beforeRanges: [{ from: 0, to: 0 }],
      ranges: [{ from: 0, to: 9 }],
      beforeContent: "",
      afterContent: "alpha\nbeta",
    };
    const previous = projectTypingResources([resource], resource.afterContent, "alpha\n");
    expect(
      advanceTypingProjectionResources(
        [resource],
        resource.afterContent,
        previous,
        "alpha\n",
        "alpha",
      ),
    ).toBeUndefined();
    expect(
      advanceTypingProjectionResources(
        [resource],
        resource.afterContent,
        previous,
        "alpha\n",
        "other",
      ),
    ).toBeUndefined();
  });

  function appendBoundaries(text: string): readonly number[] {
    const boundaries = new Set<number>();
    for (let index = 1; index <= text.length; index++) {
      boundaries.add(index);
    }
    return [...boundaries];
  }

  function lineNumber(text: string): number {
    return (text.match(/\n/gu)?.length ?? 0) + 1;
  }

  function snapshot(resource: ReturnType<typeof projectTypingResources>[number]) {
    return {
      afterContent: resource.afterContent,
      cursorOffset: resource.cursorOffset,
      model: resource.model && {
        ...resource.model,
        rows: resource.model.rows.map(
          ({ beforeLine, afterLine, kind, text, changed, addedRanges }) => ({
            beforeLine,
            afterLine,
            kind,
            text,
            changed,
            addedRanges,
          }),
        ),
      },
    };
  }
});
