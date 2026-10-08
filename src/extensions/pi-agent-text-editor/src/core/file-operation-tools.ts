import path from "node:path";
import type { TextEditorCore } from "#src/core/text-editor-core.js";
import type { FileOperation, FileOperationResult } from "#src/core/file-operations.js";
import { forgetDeferredPostEdit } from "./post-edit-scope.js";
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
  let finalize: Awaited<ReturnType<TextEditorCore["prepareFilePostProcessing"]>> | undefined;
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
      return core.executeFileOperation(operation, input, context.cwd, signal, {
        beforeDelete: (event) => core.beforeDelete(event),
        beforeFileTransfer: async () => {
          if (typeof input.target === "string")
            finalize = await core.prepareFilePostProcessing(input.target, {
              cwd: context.cwd,
              signal,
            });
        },
        ...(ui !== undefined && {
          confirm: async (event, reason) =>
            ui.confirm(
              operation === "move" ? "Move filesystem object?" : "Delete permanently?",
              [
                event.path,
                event.resolvedPath === event.path
                  ? undefined
                  : `Resolved path: ${event.resolvedPath}`,
                operation === "move" && event.path === path.resolve(context.cwd, String(input.path))
                  ? `Move source to ${String(input.target)}; preserve link objects without following their targets.`
                  : event.recursive
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
  let diffStatuses: MutationDiffStatus[] = [];
  if (outcome.ok && outcome.target !== undefined && (outcome.sourceKind ?? "file") === "file") {
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
