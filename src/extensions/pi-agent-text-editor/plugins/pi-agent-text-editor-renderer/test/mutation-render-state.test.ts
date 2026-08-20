import { requiredValue } from "../../../../../utils/required-value.js";
import { describe, expect, test } from "vitest";

import { freezeMutationViewports, projectFinalResources } from "#src/frozen-viewport.js";
import {
  advanceTypingProjectionResources,
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
});
