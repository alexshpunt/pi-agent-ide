import { requiredValue } from "pi-agent-invariant";
import { renderTextAnchor } from "pi-agent-text";
import {
  TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH,
  type ToolCallAnchorRenderState,
} from "pi-agent-tool-call-interception";
import { FileMutationAgentResult } from "#src/core/mutation-result/file-mutation-agent-result.js";
import { resolvedTextAnchorType } from "#src/core/text-anchor-registry.js";
import {
  applyTextChanges,
  type TextChange,
  TextChangeDocument,
} from "#src/core/text-change-engine.js";
import {
  executeWithBatchCoordinator,
  registerBlockedToolCall,
  registerToolBatch,
  type ToolBatchDefinition,
} from "#src/core/text-edit-batch-coordinator.js";
import {
  splitTextBatchResult,
  type TextBatchDetails,
  type TextBatchEntry,
  type TextBatchParams,
} from "#src/core/text-edit-batch.js";
import {
  contextualizeTextMutationAnchorError,
  TextMutationAnchorAggregateError,
  TextMutationAnchorResolutionError,
} from "#src/core/text-mutation-anchor-error.js";
import {
  buildFailedTextMutationResult,
  buildSuccessfulTextMutationResult,
  mutationSources,
  preflightMutationAnchors,
} from "#src/core/text-mutation.js";
import { registerBlockedToolCallSink } from "#src/core/tool-call-interceptor/coordinator.js";

import type { TextEditIntent } from "#src/api/edit-completion.js";
import type { FileMutationResult, MutationResultPresentation } from "#src/api/mutation-result.js";
import type { AnyTextMutationToolRegistration, TextMutation } from "#src/api/mutation-tool.js";
import type { BatchExecutionReporter } from "#src/core/text-edit-batch-execution.js";
import type {
  TextEditorCore,
  TextResourceEditFailure,
  TextResourcesEditOutcome,
} from "#src/core/text-editor-core.js";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface TextBatchState {
  readonly source: string;
  readonly registration: AnyTextMutationToolRegistration;
}
interface PlannedTextMutation extends TextMutation {
  readonly resultPresentations: ReadonlyMap<string, MutationResultPresentation>;
}

interface PlannedTextBatch {
  readonly mutations: readonly {
    readonly callId: string;
    readonly mutation: PlannedTextMutation;
  }[];
  readonly failures: readonly {
    readonly callId: string;
    readonly source: string;
    readonly error: unknown;
    readonly effect: "applied" | "not-applied";
  }[];
}

const renderArgumentSinks = new WeakMap<
  TextEditorCore,
  (toolCallId: string, patch: Readonly<Record<string, unknown>>) => void
>();

export function setTextEditBatchRenderArgumentSink(
  core: TextEditorCore,
  sink: (toolCallId: string, patch: Readonly<Record<string, unknown>>) => void,
): void {
  renderArgumentSinks.set(core, sink);
}

export function registerTextEditBatching(pi: ExtensionAPI, core: TextEditorCore): void {
  const sourceTools: string[] = [];
  const registrations = new Map<string, AnyTextMutationToolRegistration>();
  const renderArguments = (toolCallId: string, patch: Readonly<Record<string, unknown>>): void =>
    renderArgumentSinks.get(core)?.(toolCallId, patch);
  const definition: ToolBatchDefinition<TextBatchState> = {
    sourceTools,
    syntheticTool: "__pi_agent_text_editor_batch",
    resolveCall(call, inherited) {
      const registration = registrations.get(call.name);

      if (registration === undefined) {
        return;
      }

      const explicit = call.arguments[registration.source.field];
      const inheritedSource =
        !(typeof explicit === "string" && explicit.length > 0) && registration.source.inherited
          ? inherited?.source
          : undefined;
      const source =
        typeof explicit === "string" && explicit.length > 0 ? explicit : inheritedSource;

      return source === undefined
        ? undefined
        : {
            call,
            state: { source, registration },
            ...(inheritedSource !== undefined && {
              renderArgumentPatch: { [registration.source.field]: inheritedSource },
            }),
          };
    },
    buildArguments(calls) {
      const edits: TextBatchEntry[] = calls.map(({ call, state }) => ({
        ...call.arguments,
        [state.registration.source.field]: state.source,
        callId: call.id,
        op: state.registration.name,
        path: state.source,
      }));
      return { edits } satisfies TextBatchParams;
    },
    execute: (_toolCallId, parameters, signal, onUpdate, context, reporter) =>
      executeRegisteredTextBatch(
        core,
        registrations,
        asTextBatchParams(parameters),
        signal,
        onUpdate,
        context,
        reporter,
        renderArguments,
      ),
    splitResult: splitTextBatchResult,
    onRenderArguments: renderArguments,
  };

  core.onMutationTool((registration) => {
    registrations.set(registration.name, registration);
    sourceTools.push(registration.name);
  });
  registerBlockedToolCallSink(pi, registerBlockedToolCall);
  registerToolBatch(pi, definition);
}

export async function executeRegisteredTextBatch(
  core: TextEditorCore,
  registrations: ReadonlyMap<string, AnyTextMutationToolRegistration>,
  parameters: TextBatchParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<TextBatchDetails> | undefined,
  context: ExtensionContext,
  reporter: BatchExecutionReporter,
  renderArguments: (toolCallId: string, patch: Readonly<Record<string, unknown>>) => void,
): Promise<AgentToolResult<TextBatchDetails>> {
  const prepared = parameters.edits.map((entry) => {
    const registration = registrations.get(entry.op);

    if (registration === undefined) {
      throw new Error(`Unknown text mutation tool: ${entry.op}.`);
    }

    const { callId, op: _op, ...input } = entry;
    return { callId, input, registration, sources: mutationSources(registration, input) };
  });
  const intents = new Set(prepared.map(({ registration }) => registration.intent ?? "edit"));
  const intent: TextEditIntent =
    intents.size > 1 ? "mixed" : (intents.values().next().value ?? "edit");
  const requests = new Map<string, { source: string; read: true; allowReadFailure?: true }>();

  for (const item of prepared) {
    for (const source of item.sources.values()) {
      const current = requests.get(source);
      const isAllowReadFailure =
        item.registration.name === "write" &&
        source === item.sources.get(item.registration.source.field);
      requests.set(source, {
        source,
        read: true,
        ...((current?.allowReadFailure === true || isAllowReadFailure) && {
          allowReadFailure: true,
        }),
      });
    }

    reporter.start(item.callId);
  }

  let outcome: TextResourcesEditOutcome<PlannedTextBatch>;

  try {
    outcome = await core.editTexts(
      [...requests.values()],
      { cwd: context.cwd, intent, ...(signal !== undefined && { signal }) },
      async (texts, resolveAnchor) => {
        const mutations: PlannedTextBatch["mutations"][number][] = [];
        const failures: PlannedTextBatch["failures"][number][] = [];
        const changes = new Map<string, TextChange[]>();

        for (const item of prepared) {
          const sourceFor = (field: string): string => {
            const source = item.sources.get(field);

            if (source === undefined) {
              throw new Error(`Unknown mutation source field ${field}`);
            }

            return source;
          };
          const documentFor = (source: string): TextChangeDocument => {
            const text = texts.get(source);

            if (text === undefined) {
              throw new Error(`Unknown mutation resource ${source}`);
            }

            return new TextChangeDocument(text);
          };

          const majorAnchorSources = new Set<string>();
          const publishAnchorRenderPatch = (
            field: string,
            state: ToolCallAnchorRenderState,
          ): void => {
            renderArguments(item.callId, {
              [TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH]: { [field]: state },
            });
          };
          const resolveAnchors = async (field: string) => {
            const descriptor = (item.registration.anchors ?? []).find(
              (anchor) => anchor.field === field,
            );
            const value = item.input[field];
            const source =
              descriptor === undefined ? undefined : item.sources.get(descriptor.sourceField);

            if (descriptor === undefined || typeof value !== "string" || source === undefined) {
              publishAnchorRenderPatch(field, { kind: "failed" });
              throw new Error(`Unable to resolve mutation anchor ${field}`);
            }

            try {
              const anchor = await resolveAnchor(source, value, descriptor.kinds);
              if (resolvedTextAnchorType(anchor) === "major") {
                majorAnchorSources.add(source);
              }
              const rendered = renderTextAnchor(anchor, value, { source, anchor });
              publishAnchorRenderPatch(field, {
                kind: "resolved",
                full: rendered.full,
                compact: rendered.compact,
                resolverId: rendered.resolverId,
              });
              return new Map([[source, anchor]]);
            } catch (error) {
              publishAnchorRenderPatch(field, { kind: "failed" });
              throw contextualizeTextMutationAnchorError(
                error,
                item.registration.name,
                field,
                source,
                value,
              );
            }
          };
          try {
            const mutationContext = {
              cwd: context.cwd,
              ...(signal !== undefined && { signal }),
              sourceDocument: documentFor(sourceFor(item.registration.source.field)),
              sourceFor,
              documentFor,
              targetDocument: (field: string) => documentFor(sourceFor(field)),
              resolveAnchors,
              async resolveAnchor(field: string) {
                const resolved = await resolveAnchors(field);
                return requiredValue(resolved.values().next().value);
              },
            };
            await preflightMutationAnchors(item.registration, item.input, mutationContext);
            const mutation = await item.registration.mutate(mutationContext, item.input);
            for (const [source, edit] of mutation.edits) {
              const existing = changes.get(source) ?? [];
              if (
                edit.changes.some((change) =>
                  existing.some((prior) => textChangesConflict(prior, change)),
                )
              ) {
                throw new Error(
                  `Text mutation ${item.callId} overlaps an earlier successful mutation.`,
                );
              }
            }
            mutations.push({
              callId: item.callId,
              mutation: {
                ...mutation,
                resultPresentations: new Map(
                  [...mutation.edits.keys()].map((source) => [
                    source,
                    majorAnchorSources.has(source) ? "major-anchor" : "plain",
                  ]),
                ),
              },
            });

            for (const [source, edit] of mutation.edits) {
              changes.set(source, [...(changes.get(source) ?? []), ...edit.changes]);
            }
          } catch (error) {
            failures.push({
              callId: item.callId,
              source: item.sources.get(item.registration.source.field) ?? "",
              error,
              effect: "not-applied",
            });
          }
        }

        return { changes, result: { mutations, failures } };
      },
    );
  } catch (error) {
    return failTextBatch(
      core,
      prepared.map(({ callId }) => callId),
      error,
      context,
      reporter,
    );
  }

  if (outcome.kind === "failed") {
    return failTextBatch(
      core,
      prepared.map(({ callId }) => callId),
      outcome.failure,
      context,
      reporter,
    );
  }

  const completedMutations: PlannedTextBatch["mutations"][number][] = [];
  const failures = [...outcome.result.failures];

  for (const entry of outcome.result.mutations) {
    try {
      await entry.mutation.afterWrite?.();
      completedMutations.push(entry);
    } catch (error) {
      failures.push({
        callId: entry.callId,
        source: entry.mutation.edits.keys().next().value ?? "",
        error,
        effect: "applied",
      });
    }
  }

  const results: FileMutationResult[] = [];
  const callIdsByResult: string[] = [];
  const displayResults: FileMutationResult[] = [];
  const callIdsByDisplayResult: string[] = [];
  const finalCallIdBySource = new Map<string, string>();
  const finalPresentationBySource = new Map<string, MutationResultPresentation>();
  const resultsByCallId = new Map<string, FileMutationResult[]>();
  const displayResultsByCallId = new Map<string, FileMutationResult[]>();

  for (const { callId, mutation } of completedMutations) {
    resultsByCallId.set(callId, []);
    const callDisplayResults = [...mutation.edits].flatMap(([source, edit]) => {
      const resource = outcome.resources.find((candidate) => candidate.source === source);
      if (resource === undefined) {
        return [];
      }

      const ownAfter = applyTextChanges(resource.before.content, edit.changes).content;
      return [
        buildSuccessfulTextMutationResult(
          resource,
          source,
          edit,
          ownAfter,
          mutation.resultPresentations.get(source) ?? "plain",
        ),
      ];
    });
    displayResultsByCallId.set(callId, callDisplayResults);
    displayResults.push(...callDisplayResults);
    callIdsByDisplayResult.push(...callDisplayResults.map(() => callId));

    for (const source of mutation.edits.keys()) {
      finalCallIdBySource.set(source, callId);
      finalPresentationBySource.set(source, mutation.resultPresentations.get(source) ?? "plain");
    }
  }

  for (const [source, finalCallId] of finalCallIdBySource) {
    const resource = outcome.resources.find((candidate) => candidate.source === source);
    const edits = outcome.result.mutations.flatMap(({ mutation }) => {
      const edit = mutation.edits.get(source);
      return edit === undefined ? [] : [edit];
    });

    if (resource === undefined || edits.length === 0) {
      continue;
    }

    const result = buildSuccessfulTextMutationResult(
      resource,
      source,
      {
        changes: edits.flatMap((edit) => edit.changes),
        action: edits.some((edit) => edit.action === "overwritten") ? "overwritten" : "edited",
      },
      resource.after.content,
      finalPresentationBySource.get(source) ?? "plain",
      edits.length,
    );
    resultsByCallId.get(finalCallId)?.push(result);
    results.push(result);
    callIdsByResult.push(finalCallId);
  }

  for (const { callId } of completedMutations) {
    const callResults = resultsByCallId.get(callId) ?? [];
    const callDisplayResults = displayResultsByCallId.get(callId) ?? [];
    reporter.complete(
      callId,
      textBatchResult(
        callResults,
        callResults.map(() => callId),
        callDisplayResults,
        callDisplayResults.map(() => callId),
      ),
    );
  }

  for (const failure of failures) {
    const anchorFailures =
      failure.error instanceof TextMutationAnchorAggregateError
        ? failure.error.failures
        : failure.error instanceof TextMutationAnchorResolutionError
          ? [failure.error]
          : [];
    for (const anchorFailure of anchorFailures) {
      const resource = outcome.resources.find(({ source }) => source === anchorFailure.source);
      if (resource !== undefined) {
        await anchorFailure.resolution.refreshRecovery({
          source: resource.source,
          content: resource.after.content,
          lines: resource.after.lines.map(({ content }) => content),
          cwd: context.cwd,
          ...(signal !== undefined && { signal }),
        });
      }
    }
    const failedResult = await buildFailedTextMutationResult(
      core,
      {
        code: failure.effect === "applied" ? "POST_WRITE_FAILED" : "INVALID_REQUEST",
        source: failure.source,
        message: errorMessage(failure.error),
        cause: failure.error,
      },
      context,
      failure.effect,
    );
    const failureResults = failedResult.details.results ?? [];
    reporter.fail(failure.callId, {
      error: failure.error,
      effect: failure.effect,
      result: failedResult,
    });
    results.push(...failureResults);
    callIdsByResult.push(...failureResults.map(() => failure.callId));
    displayResults.push(...failureResults);
    callIdsByDisplayResult.push(...failureResults.map(() => failure.callId));
  }

  onUpdate?.({
    content: [{ type: "text", text: "post-edit progress" }],
    details: {
      results: [...results],
      callIdsByResult: [...callIdsByResult],
      displayResults: [...displayResults],
      callIdsByDisplayResult: [...callIdsByDisplayResult],
    },
  });
  return textBatchResult(results, callIdsByResult, displayResults, callIdsByDisplayResult);
}

async function failTextBatch(
  core: TextEditorCore,
  callIds: readonly string[],
  error: unknown,
  context: ExtensionContext,
  reporter: BatchExecutionReporter,
): Promise<AgentToolResult<TextBatchDetails>> {
  const cause = error;
  const failure = isTextResourceEditFailure(error)
    ? error
    : {
        code: "INVALID_REQUEST" as const,
        source: "",
        message: errorMessage(cause),
        cause,
      };
  const failedCallId = callIds[0];
  const failedResult = await buildFailedTextMutationResult(core, failure, context);

  for (const callId of callIds) {
    reporter.fail(callId, {
      error: cause,
      effect: "not-applied",
      ...(callId === failedCallId && { result: failedResult }),
    });
  }

  const results = failedResult.details.results ?? [];
  return textBatchResult(
    results,
    results.map(() => failedCallId ?? ""),
  );
}

function isTextResourceEditFailure(value: unknown): value is TextResourceEditFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<TextResourceEditFailure>).code === "string" &&
    typeof (value as Partial<TextResourceEditFailure>).source === "string" &&
    typeof (value as Partial<TextResourceEditFailure>).message === "string"
  );
}

function textChangesConflict(left: TextChange, right: TextChange): boolean {
  if (left.from === left.to && right.from === right.to) {
    return false;
  }
  if (left.from === left.to) {
    return left.from > right.from && left.from < right.to;
  }
  if (right.from === right.to) {
    return right.from > left.from && right.from < left.to;
  }
  return left.from < right.to && right.from < left.to;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asTextBatchParams(value: unknown): TextBatchParams {
  return value as TextBatchParams;
}

function textBatchResult(
  results: FileMutationResult[],
  callIdsByResult: string[],
  displayResults: FileMutationResult[] = results,
  callIdsByDisplayResult: string[] = callIdsByResult,
): AgentToolResult<TextBatchDetails> {
  return {
    content: [new FileMutationAgentResult(results).toTextContent()],
    details: { results, callIdsByResult, displayResults, callIdsByDisplayResult },
  };
}

export function executeTextToolWithBatch<Result>(
  toolCallId: string,
  execute: () => Promise<AgentToolResult<Result>>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Result> | undefined,
  context: ExtensionContext,
): Promise<AgentToolResult<Result>> {
  return executeWithBatchCoordinator(toolCallId, execute, signal, onUpdate, context);
}
