import {
  connectResultTargets,
  type ResultTargetStore,
  type ResultSourceTarget,
} from "pi-agent-resource";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";
import { isResultInput } from "./result-transfer.js";
import {
  committedMutationTargets,
  describeUnavailableCopyTarget,
  unchangedCopySources,
  verifyMutationTargets,
} from "./mutation-result-targets.js";
import { requiredValue } from "pi-agent-invariant";
import { postWriteFailureEffect } from "./text-mutation.js";
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
  buildFailedCopyWriteResult,
  buildFailedTextMutationResult,
  buildSuccessfulTextMutationResult,
  mutationSources,
  preflightMutationAnchors,
  textMutationOperationReceipts,
} from "#src/core/text-mutation.js";
import { registerBlockedToolCallSink } from "#src/core/tool-call-interceptor/coordinator.js";

import type { TextEditIntent } from "#src/api/edit-completion.js";
import type {
  FileMutationBatchResult,
  FileMutationResult,
  MutationResultPresentation,
} from "#src/api/mutation-result.js";
import type { AnyTextMutationToolRegistration, TextMutation } from "#src/api/mutation-tool.js";
import type { BatchExecutionReporter } from "#src/core/text-edit-batch-execution.js";
import type {
  TextEditorCore,
  TextResourceEditFailure,
  ResolveResourceTextAnchor,
  TextResourceEditRequest,
  TextResourcesEditOutcome,
} from "#src/core/text-editor-core.js";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface TextBatchState {
  readonly selection?: ResultSourceTarget;
  readonly source: string;
  readonly registration: AnyTextMutationToolRegistration;
}
interface PlannedTextMutation extends TextMutation {
  readonly operation: string;
  readonly resultPresentations: ReadonlyMap<string, MutationResultPresentation>;
}

export interface PlannedTextBatch {
  readonly changes: ReadonlyMap<string, readonly TextChange[]>;
  readonly mutations: readonly {
    readonly callId: string;
    readonly mutation: PlannedTextMutation;
  }[];
  readonly failures: readonly {
    readonly callId: string;
    readonly source: string;
    readonly error: unknown;
    readonly effect: "applied" | "not-applied" | "unknown";
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
  const resultTargets = connectResultTargets(pi);
  const sourceTools: string[] = [];
  const registrations = new Map<string, AnyTextMutationToolRegistration>();
  const renderArguments = (toolCallId: string, patch: Readonly<Record<string, unknown>>): void =>
    renderArgumentSinks.get(core)?.(toolCallId, patch);
  const definition: ToolBatchDefinition<TextBatchState> = {
    sourceTools,
    syntheticTool: "__pi_agent_text_editor_batch",
    resolveCall(call, inherited, context) {
      const registration = registrations.get(call.name);

      if (registration === undefined) {
        return;
      }

      // Derived protocol targets need their owning execution pipeline, not snapshot batching.
      const selectorFields = [
        registration.source.field,
        ...(registration.source.targets ?? []).map((target) => target.field),
        ...(registration.anchors ?? []).map((anchor) => anchor.field),
      ];
      if (
        selectorFields.some((field) => {
          const value = call.arguments[field];
          return (
            typeof value === "string" &&
            /^[a-z][a-z\d+.-]+:/iu.test(value) &&
            !value.startsWith("file://")
          );
        })
      )
        return;
      // Capture issued selections before any peer can commit a write.
      let selection: ResultSourceTarget | undefined;
      try {
        const input = resultTargets.source(call.arguments[registration.source.field], context.cwd);
        if (isResultInput(input)) {
          if (
            !["replace", "delete", "insert"].includes(registration.name) ||
            (registration.source.targets ?? []).length > 0 ||
            (registration.anchors ?? []).some(({ field }) => call.arguments[field] !== undefined)
          )
            return;
          const resolved = resultTargets.resolve(input, context.cwd);
          if (!resolved.complete || resolved.targets.length !== 1) return;
          selection = resolved.targets[0];
          if (
            selection === undefined ||
            selection.source.includes("://") ||
            selection.ranges.length === 0
          )
            return;
        } else if (
          (registration.source.targets ?? []).some(({ field }) =>
            isResultInput(resultTargets.source(call.arguments[field], context.cwd)),
          )
        )
          return;
      } catch {
        // The direct source boundary reports unknown or expired references safely.
        return;
      }
      const explicit = selection?.source ?? call.arguments[registration.source.field];
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
            state: { source, registration, ...(selection !== undefined && { selection }) },
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
      const selections = new Map(
        calls.flatMap(({ call, state }) =>
          state.selection === undefined ? [] : [[call.id, state.selection] as const],
        ),
      );
      return { edits, selections } satisfies TextBatchParams;
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
        undefined,
        resultTargets,
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

/** Plan mutations once against one snapshot; callers choose when to commit them. */
export async function planRegisteredTextBatch(
  registrations: ReadonlyMap<string, AnyTextMutationToolRegistration>,
  parameters: TextBatchParams,
  texts: ReadonlyMap<string, string>,
  resolveAnchor: ResolveResourceTextAnchor,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
  renderArguments: (toolCallId: string, patch: Readonly<Record<string, unknown>>) => void,
  priorChanges: ReadonlyMap<string, readonly TextChange[]> = new Map(),
): Promise<PlannedTextBatch> {
  const mutations: PlannedTextBatch["mutations"][number][] = [];
  const failures: PlannedTextBatch["failures"][number][] = [];
  const changes = new Map([...priorChanges].map(([source, edits]) => [source, [...edits]]));
  // Compute against immutable snapshots together; accept conflicts in call order.
  const planned = await Promise.allSettled(
    parameters.edits.map(async (entry): Promise<PlannedTextBatch["mutations"][number]> => {
      const registration = requiredValue(registrations.get(entry.op));
      const selection = parameters.selections?.get(entry.callId);
      if (selection !== undefined && texts.get(selection.source) !== selection.expectedContent)
        throw new Error("The selected source changed before the edit batch. Resolve it again.");
      const { callId, op: _op, ...input } = entry;
      const sources = mutationSources(registration, input);
      const sourceFor = (field: string): string => requiredValue(sources.get(field));
      const documentFor = (source: string) =>
        new TextChangeDocument(requiredValue(texts.get(source)));
      const majorAnchorSources = new Set<string>();
      const publish = (field: string, state: ToolCallAnchorRenderState) =>
        renderArguments(callId, {
          [TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH]: { [field]: state },
        });
      const resolveAnchors = async (field: string) => {
        const descriptor = (registration.anchors ?? []).find((anchor) => anchor.field === field);
        const value = input[field];
        if (
          selection !== undefined &&
          descriptor?.sourceField === registration.source.field &&
          value === undefined
        ) {
          return new Map([
            [selection.source, new TextSelectionAnchor(field, selection.source, selection.ranges)],
          ]);
        }
        const source = descriptor === undefined ? undefined : sources.get(descriptor.sourceField);
        if (descriptor === undefined || typeof value !== "string" || source === undefined) {
          publish(field, { kind: "failed" });
          throw new Error(`Unable to resolve mutation anchor ${field}`);
        }
        try {
          const anchor = await resolveAnchor(source, value, descriptor.kinds);
          if (resolvedTextAnchorType(anchor) === "major") majorAnchorSources.add(source);
          const rendered = renderTextAnchor(anchor, value, { source, anchor });
          publish(field, {
            kind: "resolved",
            full: rendered.full,
            compact: rendered.compact,
            resolverId: rendered.resolverId,
          });
          return new Map([[source, anchor]]);
        } catch (error) {
          publish(field, { kind: "failed" });
          throw contextualizeTextMutationAnchorError(
            error,
            registration.name,
            field,
            source,
            value,
          );
        }
      };
      const mutationContext = {
        cwd: context.cwd,
        ...(signal !== undefined && { signal }),
        sourceDocument: documentFor(sourceFor(registration.source.field)),
        sourceFor,
        documentFor,
        targetDocument: (field: string) => documentFor(sourceFor(field)),
        resolveAnchors,
        async resolveAnchor(field: string) {
          return requiredValue((await resolveAnchors(field)).values().next().value);
        },
      };
      await preflightMutationAnchors(registration, input, mutationContext);
      const mutation = await registration.mutate(mutationContext, input);
      return {
        callId,
        mutation: {
          ...mutation,
          operation: registration.name,
          resultPresentations: new Map(
            [...mutation.edits.keys()].map((source) => [
              source,
              majorAnchorSources.has(source) ? "major-anchor" : "plain",
            ]),
          ),
        },
      };
    }),
  );
  for (const [index, result] of planned.entries()) {
    const entry = requiredValue(parameters.edits[index]);
    const { callId, op: _op, ...input } = entry;
    const registration = requiredValue(registrations.get(entry.op));
    const sources = mutationSources(registration, input);
    try {
      if (result.status === "rejected") throw result.reason;
      const mutation = result.value.mutation;
      for (const [source, edit] of mutation.edits) {
        if (
          edit.changes.some((change) =>
            (changes.get(source) ?? []).some((prior) => textChangesConflict(prior, change)),
          )
        ) {
          throw new Error(`Text mutation ${callId} overlaps an earlier successful mutation.`);
        }
      }
      mutations.push(result.value);
      for (const [source, edit] of mutation.edits)
        changes.set(source, [...(changes.get(source) ?? []), ...edit.changes]);
    } catch (error) {
      if (parameters.failureMode === "abort") throw error;
      failures.push({
        callId,
        source: sources.get(registration.source.field) ?? "",
        error,
        effect: "not-applied",
      });
    }
  }
  return { changes, mutations, failures };
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
  planned?: PlannedTextBatch,
  resultTargets?: ResultTargetStore,
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
  const requests = new Map<string, TextResourceEditRequest>();

  for (const item of prepared) {
    for (const source of item.sources.values()) {
      const current = requests.get(source);
      const isAllowReadFailure =
        item.registration.name === "write" &&
        source === item.sources.get(item.registration.source.field);
      requests.set(source, {
        ...(parameters.expectedExistence?.has(source) && {
          expectedExistence: parameters.expectedExistence.get(source),
        }),
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
  let executionPlan = planned;
  const guardedSnapshots = new Map<string, string>();

  try {
    outcome = await core.editTexts(
      [...requests.values()],
      { cwd: context.cwd, intent, ...(signal !== undefined && { signal }) },
      async (texts, resolveAnchor) => {
        for (const [source, content] of texts) guardedSnapshots.set(source, content);
        for (const [source, expected] of parameters.expectedContent ?? []) {
          if (!texts.has(source) || texts.get(source) !== expected) {
            throw new Error(`Snapshot source ${source} changed before the edit batch.`);
          }
        }
        const result =
          planned ??
          (await planRegisteredTextBatch(
            registrations,
            parameters,
            texts,
            resolveAnchor,
            context,
            signal,
            renderArguments,
          ));
        executionPlan = result;
        return { changes: result.changes, result };
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
    const mutationResults = new Map<string, AgentToolResult<FileMutationBatchResult>>();
    if (outcome.failure.code === "WRITE_FAILED") {
      for (const { callId, mutation } of executionPlan?.mutations ?? []) {
        if (mutation.operation !== "copy") continue;
        const unrestored = (outcome.failure.rollback?.failed ?? outcome.completed).filter(
          (source) => mutation.edits.has(source),
        );
        const destination = unrestored[0] ?? mutation.edits.keys().next().value;
        mutationResults.set(
          callId,
          buildFailedCopyWriteResult(
            {
              ...outcome.failure,
              source: destination ?? outcome.failure.source,
              ...(outcome.failure.rollback !== undefined && {
                rollback: {
                  restored: outcome.failure.rollback.restored.filter((source) =>
                    mutation.edits.has(source),
                  ),
                  failed: outcome.failure.rollback.failed.filter((source) =>
                    mutation.edits.has(source),
                  ),
                  originallyMissing: outcome.failure.rollback.originallyMissing.filter((source) =>
                    mutation.edits.has(source),
                  ),
                },
              }),
            },
            unrestored,
          ),
        );
      }
    }
    return failTextBatch(
      core,
      prepared.map(({ callId }) => callId),
      outcome.failure,
      context,
      reporter,
      mutationResults,
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
        effect: postWriteFailureEffect(error),
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

      // The core already validated the write; a created empty resource has no text delta.
      const ownAfter = applyTextChanges(
        resource.before.content,
        edit.changes,
        resource.before.content.length === 0,
      ).content;
      return [
        buildSuccessfulTextMutationResult(
          resource,
          source,
          edit,
          ownAfter,
          mutation.resultPresentations.get(source) ?? "plain",

          1,
          textMutationOperationReceipts(mutation.operation, edit, resource.before.content),

          completedMutations.flatMap((peer) =>
            peer.callId === callId
              ? []
              : (peer.mutation.edits.get(source)?.changes ?? []).map(({ from, to, insert }) => ({
                  from,
                  to,
                  insert,
                })),
          ),
        ),
      ];
    });
    displayResultsByCallId.set(callId, callDisplayResults);
    displayResults.push(...callDisplayResults);
    callIdsByDisplayResult.push(...callDisplayResults.map(() => callId));

    const unchangedCopy =
      mutation.operation === "copy" &&
      mutation.edits.size > 0 &&
      unchangedCopySources(mutation, guardedSnapshots).size === mutation.edits.size;
    for (const source of mutation.edits.keys()) {
      if (unchangedCopy && finalCallIdBySource.has(source)) continue;
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

      completedMutations.flatMap(({ mutation }) => {
        const edit = mutation.edits.get(source);
        return edit === undefined
          ? []
          : textMutationOperationReceipts(mutation.operation, edit, resource.before.content);
      }),
    );
    resultsByCallId.get(finalCallId)?.push(result);
    results.push(result);
    callIdsByResult.push(finalCallId);
  }

  const mutationResults = new Map<string, AgentToolResult<FileMutationBatchResult>>();
  if (resultTargets) {
    const selectable = completedMutations.filter(
      ({ mutation }) =>
        ["copy", "replace", "insert"].includes(mutation.operation) && mutation.edits.size > 0,
    );
    for (const { callId, mutation } of selectable) {
      const sources = new Set(mutation.edits.keys());
      let metadata: FileMutationBatchResult["metadata"];
      try {
        const mapped = committedMutationTargets(
          completedMutations.map(({ callId, mutation }) => ({
            callId,
            edits: new Map([...mutation.edits].filter(([source]) => sources.has(source))),
          })),
          outcome.resources
            .filter((resource) => sources.has(resource.source))
            .map((resource) => ({
              source: resource.source,
              resourceSource: resource.after.source,
              resolvedBy: resource.resolvedBy,
              before: resource.before,
              after: resource.after,
              existed: true,
            })),
          guardedSnapshots,
        );
        const targets = mapped.get(callId);
        const expectedTargets = [...mutation.edits.values()].filter(
          (edit) => edit.resultChanges?.length !== 0,
        ).length;
        if (!targets || targets.length !== expectedTargets)
          throw new Error("This operation did not produce confirmed filesystem targets.");
        const verified = await verifyMutationTargets(
          core,
          targets,
          resultTargets,
          context.cwd,
          signal,
        );
        metadata = { resultTarget: resultTargets.register(verified, context.cwd) };
      } catch (error) {
        signal?.throwIfAborted();
        metadata = { targetUnavailable: errorMessage(error) };
      }
      const copy = mutation.operation === "copy";
      const unchanged =
        copy && unchangedCopySources(mutation, guardedSnapshots).size === mutation.edits.size;
      const ownResults = resultsByCallId.get(callId) ?? [];
      const displayed = displayResultsByCallId.get(callId) ?? [];
      const receipt = textBatchResult(
        copy && ownResults.length === 0 ? displayed : ownResults,
        [],
        displayed,
        [],
      );
      const ownReceipt = {
        ...receipt,
        ...(unchanged
          ? {
              content: [
                { type: "text" as const, text: "No changes: destination already has this text." },
              ],
            }
          : !copy && ownResults.length === 0
            ? {
                content: [
                  {
                    type: "text" as const,
                    text: "Batch edit applied; the final file result is in the last successful tool call for that file.",
                  },
                ],
              }
            : {}),
        details: {
          ...receipt.details,
          ...(!copy && { results: displayed }),
          effect: unchanged ? ("not-applied" as const) : ("applied" as const),
          metadata,
        },
      };
      mutationResults.set(callId, copy ? describeUnavailableCopyTarget(ownReceipt) : ownReceipt);
    }
  }
  for (const { callId } of completedMutations) {
    const callResults = resultsByCallId.get(callId) ?? [];
    const callDisplayResults = displayResultsByCallId.get(callId) ?? [];
    reporter.complete(
      callId,
      mutationResults.get(callId) ??
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
        code: failure.effect === "not-applied" ? "INVALID_REQUEST" : "POST_WRITE_FAILED",
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
  const result = textBatchResult(results, callIdsByResult, displayResults, callIdsByDisplayResult);
  return mutationResults.size === 0
    ? result
    : { ...result, details: { ...result.details, mutationResults } };
}

async function failTextBatch(
  core: TextEditorCore,
  callIds: readonly string[],
  error: unknown,
  context: ExtensionContext,
  reporter: BatchExecutionReporter,
  mutationResults: ReadonlyMap<string, AgentToolResult<FileMutationBatchResult>> = new Map(),
): Promise<AgentToolResult<TextBatchDetails>> {
  const failure = isTextResourceEditFailure(error)
    ? error
    : {
        code: "INVALID_REQUEST" as const,
        source: "",
        message: errorMessage(error),
        cause: error,
      };
  const cause = Object.assign(new Error(failure.message), { code: failure.code });
  const failedCallId = callIds[0];
  const failedResult = await buildFailedTextMutationResult(core, failure, context);
  const results: FileMutationResult[] = [];
  const callIdsByResult: string[] = [];
  for (const callId of callIds) {
    const mutationResult = mutationResults.get(callId);
    const result = mutationResult ?? (callId === failedCallId ? failedResult : undefined);
    reporter.fail(callId, {
      error: cause,
      effect: mutationResult?.details.effect ?? failedResult.details.effect ?? "not-applied",
      ...(result !== undefined && { result }),
    });
    for (const item of result?.details.results ?? []) {
      results.push(item);
      callIdsByResult.push(callId);
    }
  }
  const result = textBatchResult(results, callIdsByResult);
  return mutationResults.size === 0
    ? result
    : { ...result, details: { ...result.details, mutationResults } };
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
