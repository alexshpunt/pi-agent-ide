import { createPostEditScope } from "#src/core/post-edit-scope.js";
import { FileMutationResult } from "#src/core/mutation-result/file-mutation-result.js";
import { isFormattingContribution, isDiffStatusContribution } from "#src/api/post-edit.js";
import { executeDiff, diffReadResult } from "#src/core/diff-tool.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReadPluginApi } from "pi-agent-read/api/plugin-protocol";
import { readParameters, type ReadToolResult } from "pi-agent-read/api/tools/read";
import { searchSchema, type SearchPluginApi, type SearchRequest } from "pi-agent-search/api/search";
import { Value } from "typebox/value";
import type { TextEditorCore } from "#src/core/text-editor-core.js";
import { ApplyResults } from "#src/core/apply/results.js";
import { serializeApplyError, type ApplyRuntimeHost } from "#src/core/apply/runtime.js";
import { executeEditorTransaction } from "#src/core/apply/transaction.js";

/** Configured IDE services and ordinary tool schemas, shared with the standalone tools. */
export interface ApplyServices {
  readonly editor: TextEditorCore;
  readonly read: ReadPluginApi;
  readonly search: SearchPluginApi;
  readonly lastResolvedSource?: string;
  readonly rememberRead?: (outcome: ReadToolResult) => void;
}

/** One invocation's host-owned receipts, with guest errors independent of output selection. */
export function createApplyExecution(
  services: ApplyServices,
  context: ExtensionContext,
): {
  readonly host: ApplyRuntimeHost;
  readonly results: ApplyResults;
  finish(): Promise<void>;
} {
  const results = new ApplyResults();
  const scope = createPostEditScope();
  let lastSource = services.lastResolvedSource;
  const host: ApplyRuntimeHost = {
    async execute(operation, arguments_, signal, id) {
      const tool = operation;
      const kind =
        tool === "read" || tool === "search" || tool === "diff" || tool === "editorOpen"
          ? "read"
          : "mutation";
      let recorded = false;
      try {
        if (tool === "editorApply") {
          let value;
          try {
            value = await executeEditorTransaction(services.editor, arguments_, signal, context);
          } catch (error) {
            const details =
              error !== null && typeof error === "object" && "details" in error
                ? error.details
                : undefined;
            if (
              details !== null &&
              typeof details === "object" &&
              "files" in details &&
              Array.isArray(details.files)
            )
              for (const source of details.files)
                if (typeof source === "string") scope.forget(source);
            throw error;
          }
          results.record(id, "mutation", value);
          recorded = true;
          for (const file of value.files) {
            results.updateFile(file.source, file.before, file.after);
            lastSource = file.source;
          }
          return value;
        }
        if (tool === "editorOpen") {
          if (!Value.Check(readParameters, arguments_))
            throw failure("INVALID_ARGUMENTS", "Invalid arguments for open");
          const outcome = await services.read.read(
            arguments_,
            { cwd: context.cwd, signal },
            "script",
          );
          const value = outcome.script;
          if (
            outcome.isError ||
            outcome.details.resolvedBy !== "filesystem" ||
            value?.kind !== "text" ||
            typeof value.content !== "string"
          )
            throw failure("NOT_EDITABLE_TEXT", "open() requires one local text file");
          const snapshot = {
            id,
            source: outcome.details.source ?? value.source,
            content: value.content,
            lines: value.lines,
          };
          results.record(id, "read", snapshot, outcome);
          recorded = true;
          lastSource = snapshot.source;
          services.rememberRead?.(outcome);
          return snapshot;
        }
        if (tool === "diff") {
          const value = await executeDiff(services.read, arguments_, { cwd: context.cwd, signal });
          results.record(id, "read", value, diffReadResult(value));
          return value;
        }
        const schema = tool === "read" ? readParameters : searchSchema;
        if (!Value.Check(schema, arguments_))
          throw failure("INVALID_ARGUMENTS", `Invalid arguments for ${tool}`);
        if (tool === "read") {
          const outcome = await services.read.read(
            arguments_,
            { cwd: context.cwd, signal },
            "script",
          );
          const value = {
            ...(outcome.script ?? {
              kind: "native",
              source: outcome.details.source,
              blocks: outcome.content,
            }),
            ok: !outcome.isError && outcome.details.failure === undefined,
          };
          results.record(id, kind, value, outcome);
          recorded = true;
          if (outcome.isError || outcome.details.failure)
            throw failure(
              readFailureCode(outcome.details.failure),
              outcome.details.failure?.message ?? "Read failed",
              value,
            );
          lastSource = outcome.details.source ?? lastSource;
          services.rememberRead?.(outcome);
          return value;
        }
        const outcome = await services.search.search(
          arguments_ as SearchRequest,
          {
            cwd: context.cwd,
            signal,
          },
          "script",
        );
        const searchFailure = outcome.details.failure;
        const value = {
          ...outcome.script,
          ok: searchFailure === undefined,
          ...(searchFailure && { error: searchFailure }),
        };
        results.record(id, kind, value, { content: outcome.content, details: {} });
        recorded = true;
        if (searchFailure !== undefined)
          throw failure("SEARCH_FAILED", "Search failed", searchFailure);
        return value;
      } catch (error) {
        if (!recorded)
          results.record(id, kind, { operation, ok: false, error: serializeApplyError(error) });
        throw error;
      }
    },
    async result(value, id) {
      results.add(value, id);
    },
  };
  return {
    host: { ...host, execute: (...args) => scope.run(() => host.execute(...args)) },
    results,
    async finish() {
      await services.editor.enqueueFileOperation(() =>
        scope.finish((outcome) => {
          const source = outcome.after.source;
          const previous = results.mutationPresentation(source)?.data;
          const formatting = outcome.postEditContributions
            .map((item) => item.data)
            .findLast(isFormattingContribution)?.formatting;
          if (
            !previous &&
            outcome.before.content === outcome.after.content &&
            !formatting?.formatter
          )
            return;
          results.updateFile(source, outcome.before.content, outcome.after.content);
          results.rememberMutation(
            source,
            new FileMutationResult({
              ok: true,
              path: source,
              ...previous,
              afterContent: outcome.after.content,
              afterDocument: outcome.after,
              diffStatuses: outcome.postEditContributions
                .map((item) => item.data)
                .filter(isDiffStatusContribution)
                .flatMap((item) => item.diffStatuses),
              formatting: formatting ?? { status: "not-reported" },
            }),
          );
        }),
      );
    },
  };
}

function failure(code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { code, details });
}

function readFailureCode(
  failure: { readonly code: string; readonly cause?: unknown } | undefined,
): string {
  const cause = failure?.cause;
  return cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    typeof cause.code === "string"
    ? cause.code
    : (failure?.code ?? "READ_FAILED");
}
