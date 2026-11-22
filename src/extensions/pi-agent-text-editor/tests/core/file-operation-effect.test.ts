import { expect, test } from "vitest";
import { executeWholeFileTool } from "#src/core/file-operation-tools.ts";
import type { FileOperationResult } from "#src/core/file-operations.ts";
import { createTextEditorCore, type TextEditorCore } from "#src/core/text-editor-core.ts";

function coreReturning(effect: FileOperationResult["effect"]): TextEditorCore {
  const outcome: FileOperationResult = {
    kind: "file-operation",
    operation: "copy",
    ok: false,
    effect,
    path: "/work/source",
    target: "/work/target",
    error: { code: "EIO", message: "Copy stopped" },
  };
  const core = createTextEditorCore();
  core.executeFileOperation = () => Promise.resolve(outcome);
  return core;
}

async function resultText(effect: FileOperationResult["effect"]): Promise<string> {
  const result = await executeWholeFileTool(
    coreReturning(effect),
    "copy",
    { path: "source", target: "target" },
    undefined,
    { cwd: "/work" },
  );
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

test("a failure with an unknown effect asks for a check before retrying", async () => {
  expect(await resultText("unknown")).toContain("Check the affected paths before retrying");
  expect(await resultText("not-applied")).not.toContain("Check the affected paths");
});
