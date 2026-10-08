import type { TextEditorCore } from "#src/core/text-editor-core.js";
import type { FileOperation } from "#src/core/file-operations.js";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FileMutationBatchResult } from "#src/core/mutation-result/file-mutation-result.js";
import { isDiffStatusContribution } from "#src/api/post-edit.js";
import type { MutationDiffStatus } from "#src/api/mutation-result.js";

/** Return whether a hybrid text tool invocation addresses a complete file. */
export function isWholeFileInvocation(
  operation: FileOperation | undefined,
  input: Readonly<Record<string, unknown>>,
): operation is FileOperation {
  if (
    operation === undefined ||
    typeof input.path !== "string" ||
    input.path.length === 0 ||
    input.path.startsWith("SEARCH#") ||
    input.path.startsWith("RESULT#")
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
  verifyFileSource?: () => Promise<void>,
): Promise<AgentToolResult<FileMutationBatchResult>> {
  let finalize: Awaited<ReturnType<TextEditorCore["prepareFilePostProcessing"]>> | undefined;
  const outcome = await core.enqueueFileOperation(async () => {
    await verifyFileSource?.();
    if (typeof input.target === "string")
      finalize = await core.prepareFilePostProcessing(input.target, { cwd: context.cwd, signal });
    return core.executeFileOperation(operation, input, context.cwd, signal);
  }, signal);
  let postProcessingError: string | undefined;
  let diffStatuses: MutationDiffStatus[] = [];
  if (outcome.ok && outcome.target !== undefined) {
    try {
      const saved = await finalize?.();
      if (saved?.kind === "completed")
        diffStatuses = saved.postEditContributions
          .map((item) => item.data)
          .filter(isDiffStatusContribution)
          .flatMap((item) => item.diffStatuses);
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
          ...diffStatuses.map((status) => status.text),
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
          diffStatuses,
          ...(postProcessingError === undefined ? {} : { postProcessingError }),
          source: outcome.path,
        },
      },
    },
  };
}
