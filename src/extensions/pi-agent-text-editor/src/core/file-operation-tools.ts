import type { TextEditorCore } from "#src/core/text-editor-core.js";
import type { FileOperation } from "#src/core/file-operations.js";
import { executeFileOperation } from "#src/core/file-operations.js";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FileMutationBatchResult } from "#src/core/mutation-result/file-mutation-result.js";

/** Return whether a hybrid text tool invocation addresses a complete file. */
export function isWholeFileInvocation(
  operation: FileOperation | undefined,
  input: Readonly<Record<string, unknown>>,
): operation is FileOperation {
  if (
    operation === undefined ||
    typeof input.path !== "string" ||
    input.path.length === 0 ||
    input.path.startsWith("SEARCH#")
  )
    return false;
  if (["start", "end", "targetStart", "targetEnd"].some((field) => field in input)) return false;
  return operation === "delete" || (typeof input.target === "string" && input.target.length > 0);
}

/** Execute the complete-file mode shared by copy, move, and delete. */
export async function executeWholeFileTool(
  core: TextEditorCore,
  operation: FileOperation,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
): Promise<AgentToolResult<FileMutationBatchResult>> {
  const outcome = await core.enqueueFileOperation(
    () => executeFileOperation(operation, input, context.cwd, signal),
    signal,
  );
  let postProcessingError: string | undefined;
  if (outcome.ok && outcome.target !== undefined) {
    try {
      await core.postProcessFile(outcome.target, { cwd: context.cwd, signal });
    } catch (error) {
      postProcessingError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    content: [
      {
        type: "text",
        text: [
          `${operation}: ${outcome.effect}`,
          outcome.path,
          outcome.target === undefined ? undefined : `Target: ${outcome.target}`,
          postProcessingError === undefined
            ? undefined
            : `Post-processing failed: ${postProcessingError}`,
          outcome.error === undefined
            ? undefined
            : `${outcome.error.code}: ${outcome.error.message}`,
        ]
          .filter((line) => line !== undefined)
          .join("\n"),
      },
    ],
    details: {
      results: [],
      metadata: {
        semanticAction: {
          ...outcome,
          ...(postProcessingError === undefined ? {} : { postProcessingError }),
          source: outcome.path,
        },
      },
    },
  };
}
