import type { TextEditorCore } from "#src/core/text-editor-core.js";
import type { FileOperation, FileOperationResult } from "#src/core/file-operations.js";
import { executeFileOperation } from "#src/core/file-operations.js";
import { forgetDeferredPostEdit } from "./post-edit-scope.js";
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
    input.path.startsWith("SEARCH#") ||
    input.path.startsWith("RESULT#") ||
    (operation === "delete" && input.path.startsWith("symbol:")) ||
    (typeof input.target === "string" && input.target.startsWith("RESULT#"))
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
  context: Pick<ExtensionContext, "cwd"> & {
    readonly hasUI?: boolean;
    readonly ui?: Pick<ExtensionContext["ui"], "confirm">;
  },
  verifySource?: () => Promise<void>,
): Promise<AgentToolResult<FileMutationBatchResult>> {
  const ui = context.hasUI ? context.ui : undefined;
  const outcome = await core.enqueueFileOperation(
    async (): Promise<FileOperationResult> => {
      try {
        await verifySource?.();
      } catch (error) {
        signal?.throwIfAborted();
        return {
          kind: "file-operation",
          operation,
          ok: false,
          effect: "not-applied",
          path: typeof input.path === "string" ? input.path : undefined,
          target: typeof input.target === "string" ? input.target : undefined,
          error: {
            code: "RESULT_INPUT_REJECTED",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      return executeFileOperation(operation, input, context.cwd, signal, {
        beforeDelete: (event) => core.beforeDelete(event),
        ...(ui !== undefined && {
          confirm: async (event, reason) =>
            ui.confirm(
              "Delete permanently?",
              [
                event.path,
                event.resolvedPath === event.path
                  ? undefined
                  : `Resolved path: ${event.resolvedPath}`,
                event.recursive
                  ? "Remove directory and all contents recursively."
                  : "Unlink symlink only; leave its target untouched.",
                reason,
              ]
                .filter((line) => line !== undefined)
                .join("\n"),
              { signal },
            ),
        }),
      });
    },
    signal,
    {
      cwd: context.cwd,
      sources: [input.path, input.target].filter(
        (value): value is string => typeof value === "string",
      ),
    },
  );
  if (outcome.ok && operation !== "copy" && outcome.path !== undefined)
    forgetDeferredPostEdit(outcome.path);
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
