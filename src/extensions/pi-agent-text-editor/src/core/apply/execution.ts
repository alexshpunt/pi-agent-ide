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
import { executeEditorTransaction, type EditorSnapshot } from "#src/core/apply/transaction.js";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";
import { TextAnchorResolutionError } from "#src/core/text-anchor-registry.js";
import { buildFailedTextMutationResult } from "#src/core/text-mutation.js";
import { TextMutationAnchorResolutionError } from "#src/core/text-mutation-anchor-error.js";

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
      const resolveMutationTarget = async (): Promise<unknown> => {
        const request = arguments_ as {
          snapshot?: { id?: unknown; source?: unknown; content?: unknown };
          query?: unknown;
        };
        const snapshot = request.snapshot;
        const content = snapshot?.content;
        if (
          snapshot === undefined ||
          typeof snapshot.id !== "string" ||
          typeof snapshot.source !== "string" ||
          typeof content !== "string" ||
          typeof request.query !== "string"
        )
          throw failure("INVALID_ARGUMENTS", "Invalid mutation-target resolution request");
        let anchor;
        try {
          anchor = await services.editor.resolveAnchorInText({
            source: snapshot.source,
            content,
            value: request.query,
            cwd: context.cwd,
            signal,
          });
        } catch (error) {
          if (!(error instanceof TextAnchorResolutionError)) throw error;
          const cause = new TextMutationAnchorResolutionError(
            "apply",
            "target",
            snapshot.source,
            request.query,
            error,
          );
          const presentation = await buildFailedTextMutationResult(
            services.editor,
            { code: "RESOLVE_FAILED", source: snapshot.source, message: error.message, cause },
            { ...context, signal },
          );
          return {
            selections: [],
            warning: {
              code: "EMPTY_SELECTION",
              message: presentation.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n"),
              presentation: {
                anchorRecoveries: presentation.details.anchorRecoveries,
              },
            },
          };
        }
        const starts = lineStarts(content);
        if (!TextSelectionAnchor.is(anchor)) {
          const from = starts[anchor.lineNumber - 1];
          if (from === undefined)
            throw failure("INVALID_SELECTION", "Anchor line is outside the opened snapshot");
          const to = starts[anchor.lineNumber] ?? content.length;
          return {
            selections: [
              {
                document: snapshot.id,
                from,
                to,
                text: content.slice(from, to),
                linewise: true,
              },
            ],
          };
        }
        return {
          selections: anchor.ranges.map((range) => {
            const from = positionOffset(starts, range.start.lineNumber, range.start.column);
            const to = positionOffset(starts, range.end.lineNumber, range.end.column);
            return {
              document: snapshot.id,
              from,
              to,
              text: content.slice(from, to),
              ...(range.linewise === true && { linewise: true }),
            };
          }),
        };
      };
      if (tool === "editorResolve") return await resolveMutationTarget();
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
          const requestedSnapshots =
            (arguments_ as { snapshots?: readonly EditorSnapshot[] }).snapshots ?? [];
          const refreshed = await Promise.all(
            requestedSnapshots.map(async (snapshot) => {
              const outcome = await services.read.read(
                { path: snapshot.source },
                { cwd: context.cwd, signal },
                "script",
              );
              const script = outcome.script;
              return !outcome.isError &&
                script?.kind === "text" &&
                typeof script.content === "string"
                ? {
                    id: snapshot.id,
                    source: outcome.details.source ?? script.source,
                    content: script.content,
                    lines: script.lines,
                  }
                : { id: snapshot.id, unavailable: true };
            }),
          );
          const response = { ...value, snapshots: refreshed };
          results.record(id, "mutation", response);
          recorded = true;
          for (const file of value.files) {
            results.updateFile(file.source, file.before, file.after);
            lastSource = file.source;
          }
          return response;
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

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1)
    if (content[index] === "\n") starts.push(index + 1);
  return starts;
}
function positionOffset(starts: readonly number[], line: number, column: number): number {
  return (starts[line - 1] ?? 0) + column;
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
