import { requiredValue } from "pi-agent-invariant";
import { ResourceError } from "pi-agent-resource";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TextEditCompletion } from "#src/api/edit-completion.js";
import type {
  TextAnchorRecoveryCandidateRange,
  TextAnchorRecoveryRange,
  TextAnchorRejection,
  TextSelectionRange,
  TextTarget,
} from "pi-agent-text";

import {
  type AgentToolResult,
  defineTool,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  type FileMutationBatchResult,
  FileMutationResult,
  type MutationResultPresentation,
  type MutationOperationReceipt,
} from "#src/api/mutation-result.js";
import {
  isMutationAnchorValue,
  mutationSource,
  type TextMutation,
  type TextMutationContext,
  type TextMutationEdit,
  type TextMutationToolRegistration,
} from "#src/api/mutation-tool.js";
import {
  isFormattingContribution,
  isDiffStatusContribution,
  isTextMutationResultContributionData,
} from "#src/api/post-edit.js";
import {
  formatStaleAnchorMessage,
  type StaleAnchorMessageDetails,
} from "#src/api/stale-anchor-message.js";
import { createUnifiedDiff } from "#src/core/mutation-result/diff.js";
import { FileMutationAgentResult } from "#src/core/mutation-result/file-mutation-agent-result.js";
import { readTextAnchorRecovery } from "#src/core/text-anchor-recovery.js";
import { applyTextChanges, TextChangeDocument } from "#src/core/text-change-engine.js";
import { resolvedTextAnchorType } from "#src/core/text-anchor-registry.js";
import { executeTextToolWithBatch } from "#src/core/text-edit-batch-registrar.js";
import {
  executeNativeTextEditBatch,
  runNativePostEditScope,
  recordNativeTextMutation,
} from "#src/core/native-text-edit-batch.js";
import {
  attachCommittedMutationTarget,
  attachWriteTarget,
  describeUnavailableCopyTarget,
  unchangedCopySources,
} from "./mutation-result-targets.js";
import { wholeFileResultSource } from "./result-input.js";
import { TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import { isResultInput, prepareResultTransfer } from "./result-transfer.js";
import {
  contextualizeTextMutationAnchorError,
  TextMutationAnchorAggregateError,
  TextMutationAnchorResolutionError,
} from "#src/core/text-mutation-anchor-error.js";
import {
  TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH,
  type ToolCallInterceptionRenderStore,
  withToolCallInterceptionRendering,
} from "#src/core/tool-call-interceptor/rendering.js";

import type { TextEditExecutionOutcome } from "#src/api/edit-pipeline.js";
import type {
  TextMutationPreviewOutcome,
  TextMutationPreviewRequest,
} from "#src/api/mutation-preview.js";
import type {
  ResolveResourceTextAnchor,
  TextEditorCore,
  TextResourceEditFailure,
  TextResourceEditOutcome,
  TextResourcesEditOutcome,
} from "#src/core/text-editor-core.js";
import { renderTextAnchor, type TextAnchor } from "pi-agent-text";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";
import type { ToolCallAnchorRenderState } from "pi-agent-tool-call-interception";
import type { Static, TSchema } from "typebox";
import { executeWholeFileTool, isWholeFileInvocation } from "#src/core/file-operation-tools.js";
import { EDITING_GUIDELINES } from "#src/core/editing-guidelines.js";
import { mutationResultSchema, structuredMutation } from "./structured-result.js";
import type { ResultTargetStore } from "pi-agent-resource";

export function createTextTool<TParameters extends TSchema>(
  core: TextEditorCore,
  definition: TextMutationToolRegistration<TParameters>,
  annotations: ToolCallInterceptionRenderStore,
  getLastResolvedSource: () => string | undefined,
  resultTargets?: ResultTargetStore,
): ToolDefinition<TParameters, FileMutationBatchResult> {
  const renderer = core.getToolRenderer(definition.name);
  const initialRenderCall = renderer?.renderCall;
  const initialRenderResult = renderer?.renderResult;

  const tool = withToolCallInterceptionRendering<TParameters, FileMutationBatchResult, unknown>(
    defineTool<TParameters, FileMutationBatchResult, unknown>({
      name: definition.name,
      exposure: "direct",
      namespace: {
        name: "ide_edit",
        description: "Edit files and live IDE resources with guarded operations.",
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      label: definition.name,

      promptSnippet: definition.promptSnippet,
      promptGuidelines: [...EDITING_GUIDELINES, ...(definition.promptGuidelines ?? [])],
      description: definition.description,
      parameters: definition.parameters,
      outputSchema: mutationResultSchema(definition.name),
      prepareArguments: (arguments_) =>
        // oxlint-disable-next-line typescript/no-unsafe-return -- TypeBox resolves only concrete tool schemas.
        prepareGuardedArguments(
          definition.parameters,
          arguments_,
          definition.source.inherited ? definition.source.field : undefined,
          getLastResolvedSource(),
          definition.anchors ?? [],
          definition.wholeFileOperation !== undefined,
        ),
      ...(renderer?.renderShell !== undefined && { renderShell: renderer.renderShell }),
      ...(initialRenderCall !== undefined && {
        renderCall: (...arguments_: Parameters<typeof initialRenderCall>) =>
          (core.getToolRenderer(definition.name)?.renderCall ?? initialRenderCall)(...arguments_),
      }),
      ...(initialRenderResult !== undefined && {
        renderResult: (...arguments_: Parameters<typeof initialRenderResult>) =>
          (core.getToolRenderer(definition.name)?.renderResult ?? initialRenderResult)(
            ...arguments_,
          ),
      }),
      async execute(toolCallId, parameters, signal, onUpdate, context) {
        let plannedEdits: ReadonlyMap<string, TextMutationEdit> | undefined;
        const copyPlan = { snapshots: new Map<string, string>(), unchanged: false };
        const captured = await runNativePostEditScope(
          core,
          toolCallId,
          () =>
            captureScriptMutation(core, async () => {
              const execute = async (): Promise<AgentToolResult<FileMutationBatchResult>> => {
                let input = asMutationParameters<TParameters>(parameters);
                if (
                  ["replace", "write", "delete", "undo", "insert"].includes(definition.name) &&
                  isResultInput(input[definition.source.field])
                ) {
                  try {
                    if (resultTargets === undefined)
                      throw new Error("Result targets are unavailable.");
                    if (input.start !== undefined || input.end !== undefined)
                      throw new Error("Do not combine result targets with start/end.");
                    const selected = resultTargets.resolve(
                      input[definition.source.field],
                      context.cwd,
                    );
                    if (!selected.complete)
                      throw new Error(
                        "Incomplete result targets cannot establish a complete edit. Run Search again with a higher limit or a narrower query, then use the complete result.",
                      );
                    await resultTargets.verify(selected, signal);
                    if (definition.name === "write" || definition.name === "undo")
                      wholeFileResultSource(selected, definition.name);
                    if (selected.targets.length === 0)
                      return {
                        content: [{ type: "text", text: "Empty result target set; no changes." }],
                        details: {
                          results: [],
                          effect: "not-applied",
                          metadata: { emptyTargets: true },
                        },
                      };
                    input = {
                      ...input,
                      [definition.source.field]: resultTargets.register(
                        selected.targets,
                        context.cwd,
                        selected.complete,
                      ),
                    };
                  } catch (error) {
                    signal?.throwIfAborted();
                    return failureToolResult(
                      "",
                      "RESULT_INPUT_REJECTED",
                      errorMessage(error),
                      "not-applied",
                    );
                  }
                }
                let executionDefinition = definition;
                let verifyFileSource: (() => Promise<void>) | undefined;
                if (
                  (definition.name === "copy" || definition.name === "move") &&
                  (isResultInput(input.path) || isResultInput(input.target))
                ) {
                  try {
                    if (resultTargets === undefined)
                      throw new Error("Result targets are unavailable.");
                    const prepared = await prepareResultTransfer(
                      definition.name,
                      input,
                      resultTargets,
                      context.cwd,
                      signal,
                    );
                    input = asMutationParameters<TParameters>(prepared.input);
                    verifyFileSource = prepared.verifyFileSource;
                    if (prepared.empty)
                      return {
                        content: [
                          {
                            type: "text",
                            text:
                              definition.name === "copy"
                                ? "No changes: empty selection."
                                : "Empty result target set; no changes.",
                          },
                        ],
                        details: {
                          results: [],
                          effect: "not-applied",
                          metadata: { emptyTargets: true },
                        },
                      };
                    if (prepared.mutate !== undefined)
                      executionDefinition = { ...definition, mutate: prepared.mutate };
                  } catch (error) {
                    signal?.throwIfAborted();
                    return failureToolResult(
                      "",
                      "RESULT_INPUT_REJECTED",
                      errorMessage(error),
                      "not-applied",
                    );
                  }
                }
                const directDefinition = executionDefinition;
                executionDefinition = {
                  ...directDefinition,
                  mutate: async (mutationContext, arguments_) => {
                    const mutation = await directDefinition.mutate(mutationContext, arguments_);
                    plannedEdits = mutation.edits;
                    if (definition.name === "copy") {
                      for (const source of mutation.edits.keys())
                        copyPlan.snapshots.set(source, mutationContext.documentFor(source).content);
                      copyPlan.unchanged =
                        mutation.edits.size > 0 &&
                        unchangedCopySources(mutation, copyPlan.snapshots).size ===
                          mutation.edits.size;
                    }
                    return mutation;
                  },
                };
                const queued = executeNativeTextEditBatch(
                  core,
                  toolCallId,
                  definition,
                  input,
                  signal,
                  context,
                );
                if (queued !== undefined) return queued;
                if (definition.direct?.matches(input) === true) {
                  try {
                    const action = await definition.direct.execute(
                      { cwd: context.cwd, ...(signal !== undefined && { signal }) },
                      input,
                    );
                    return {
                      content: [{ type: "text", text: action.summary }],
                      details: {
                        results: [],
                        metadata: { semanticAction: { ...action.data, source: action.source } },
                      },
                    };
                  } catch (error) {
                    const code =
                      error !== null && typeof error === "object" && "code" in error
                        ? String(error.code)
                        : "DIRECT_MUTATION_FAILED";
                    return failureToolResult(
                      "transaction" in input ? String(input.transaction) : "",
                      code,
                      error instanceof ResourceError
                        ? `${error.code}: ${error.source}`
                        : error instanceof Error
                          ? error.message
                          : String(error),
                      declaredMutationEffect(error),
                    );
                  }
                }
                if (
                  isWholeFileInvocation(definition.wholeFileOperation, input) &&
                  core.getSemanticMutationHandler(definition.name, input) === undefined
                ) {
                  return executeWholeFileTool(
                    core,
                    definition.wholeFileOperation,
                    input,
                    signal,
                    context,
                    verifyFileSource,
                  );
                }
                const directExecute = () =>
                  executeTextMutation(
                    core,
                    executionDefinition,
                    input,
                    signal,
                    context,
                    (field, state) =>
                      annotations.resolveArguments(toolCallId, {
                        [TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH]: { [field]: state },
                      }),
                    getLastResolvedSource(),
                  );
                return executeTextToolWithBatch(
                  toolCallId,
                  directExecute,
                  signal,
                  onUpdate,
                  context,
                );
              };
              return execute();
            }),
          definition.name === "write",
        );
        if (captured.kind === "failed") {
          const failed = failureToolResult(
            "",
            "EXECUTION_FAILED",
            errorMessage(captured.error),
            "unknown",
            undefined,
            definition.name === "copy",
          );
          return structuredMutation(failed, definition.name, captured.completions, toolCallId);
        }
        const completedValue =
          copyPlan.unchanged && captured.completions.length === 0 && !captured.value.isError
            ? {
                ...captured.value,
                content: [
                  { type: "text" as const, text: "No changes: destination already has this text." },
                ],
                details: { ...captured.value.details, effect: "not-applied" as const },
              }
            : captured.value;
        recordNativeTextMutation(core, toolCallId, completedValue);
        const value =
          resultTargets &&
          ["replace", "insert", "write", "copy", "move", "undo"].includes(definition.name)
            ? definition.name === "write"
              ? await attachWriteTarget(completedValue, core, resultTargets, context.cwd, signal)
              : await attachCommittedMutationTarget(
                  completedValue,
                  captured.completions,
                  core,
                  resultTargets,
                  toolCallId,
                  context.cwd,
                  signal,
                  definition.name === "undo",
                  plannedEdits,
                  definition.name === "copy" || definition.name === "move",
                  copyPlan.snapshots,
                )
            : completedValue;
        return structuredMutation(
          definition.name === "copy" ? describeUnavailableCopyTarget(value) : value,
          definition.name,
          captured.completions,
          toolCallId,
        );
      },
    }),
    annotations,
  );
  Object.defineProperty(tool, "description", {
    enumerable: true,
    get(): string {
      return [
        definition.description,
        core.renderToolPromptGuideline(definition.name) ?? "",
        (
          {
            replace:
              "This result selects the resulting text; empty replacement selects the resulting position, not the removed text.",
            insert:
              "For text edits, this result selects the inserted text, including supplied line separators. Specialized resources return their own action result.",
            write:
              "For file writes, this result selects the whole file, not only its changed span.",
            copy: "This result selects only the copied destination text; a whole-file copy selects the whole destination. Copy edits only the destination.",
            move: "Use the Move result to work with the inserted destination text, including any added line separators. Source removals are not selected. A whole-file move selects the whole destination when a reusable text result is available.",
            delete: "Delete returns no reusable text selection.",
            undo: "The result selects the whole restored text file, not only the reversed span.",
          } as Record<string, string>
        )[definition.name] ?? "",
        definition.name === "replace"
          ? "Pass the unchanged result to another source tool to use its selection. If it has no text selection, read the file again."
          : definition.name === "write"
            ? "For file writes, pass this unchanged result to another source tool for dependent work. If the result reports no verified text selection, inspect the file instead."
            : definition.name === "undo"
              ? "Pass the unchanged result to another source tool for dependent work. If no verified text selection is returned, read the file again."
              : ["insert", "copy", "move"].includes(definition.name)
                ? "Pass this unchanged result to another source tool for dependent work." +
                  " If the result reports no verified text selection, inspect the file instead."
                : "",
        definition.source.inherited && !["delete", "undo"].includes(definition.name)
          ? definition.wholeFileOperation === undefined
            ? `When ${definition.source.field} is omitted, the tool can reuse the file identified by the supplied anchor, the last read, or the preceding edit in the same batch.`
            : `When ${definition.source.field} is omitted, the tool can reuse the file identified by a supplied text anchor.`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  });
  return tool;
}

function prepareGuardedArguments<TParameters extends TSchema>(
  schema: TParameters,
  arguments_: unknown,
  sourceField: string | undefined,
  lastResolvedSource: string | undefined,
  anchorFields: NonNullable<TextMutationToolRegistration["anchors"]>,
  hasWholeFileMode: boolean,
): ReturnType<
  NonNullable<ToolDefinition<TParameters, FileMutationBatchResult>["prepareArguments"]>
> {
  const prepared =
    arguments_ !== null && typeof arguments_ === "object" && !Array.isArray(arguments_)
      ? { ...(arguments_ as Record<string, unknown>) }
      : {};
  const required = (schema as { required?: unknown }).required;
  const properties = (schema as { properties?: Record<string, { type?: unknown }> }).properties;

  // Anchor ownership is asynchronous; defer its source fallback until resources resolve.
  const hasExplicitAnchor = anchorFields.some((descriptor) =>
    isMutationAnchorValue(descriptor, prepared[descriptor.field]),
  );
  if (
    sourceField !== undefined &&
    !(sourceField in prepared) &&
    lastResolvedSource !== undefined &&
    !hasExplicitAnchor &&
    !hasWholeFileMode
  ) {
    prepared[sourceField] = lastResolvedSource;
  }

  if (Array.isArray(required)) {
    for (const field of required) {
      if (
        typeof field === "string" &&
        !(field in prepared) &&
        properties?.[field]?.type === "string"
      ) {
        prepared[field] = "";
      }
    }
  }

  // oxlint-disable-next-line typescript/no-unsafe-return -- TypeBox resolves only concrete tool schemas.
  return prepared as ReturnType<
    NonNullable<ToolDefinition<TParameters, FileMutationBatchResult>["prepareArguments"]>
  >;
}

interface ResolvedMutationSources {
  readonly fields: ReadonlyMap<string, string>;
  readonly anchors: ReadonlyMap<string, readonly string[]>;
  readonly implicitTargets: ReadonlyMap<string, readonly TextTarget[]>;
  readonly targets: readonly TextTarget[];
  readonly resources: readonly string[];
}

async function resolveMutationSources(
  core: TextEditorCore,
  definition: TextMutationToolRegistration,
  input: Readonly<Record<string, unknown>>,
  context: { readonly cwd: string; readonly signal?: AbortSignal },
  lastResolvedSource?: string,
): Promise<ResolvedMutationSources> {
  const expandedByAnchor = new Map<string, readonly TextTarget[]>();
  const expandedBySourceField = new Map<string, readonly TextTarget[]>();
  const expandedFromExplicitSource = new Set<string>();
  const sourceSelections = new Map<string, readonly TextTarget[]>();
  const explicitlyScopedSourceFields = new Set<string>();
  const allKinds = [
    ...new Set((definition.anchors ?? []).flatMap((descriptor) => descriptor.kinds)),
  ];
  const resolveTargets = async (
    value: string,
    field: string,
    source: string,
  ): Promise<readonly TextTarget[] | undefined> => {
    try {
      return await core.resolveTextAnchorResources(
        value,
        value.startsWith("RESULT#") ? [...allKinds, TEXT_SEARCH_ANCHOR_KIND] : allKinds,
        context,
      );
    } catch (error) {
      throw contextualizeTextMutationAnchorError(error, definition.name, field, source, value);
    }
  };

  for (const descriptor of definition.anchors ?? []) {
    const value = input[descriptor.field];
    if (!isMutationAnchorValue(descriptor, value)) continue;
    const expanded = await resolveTargets(
      value,
      descriptor.field,
      typeof input[descriptor.sourceField] === "string"
        ? String(input[descriptor.sourceField])
        : "",
    );
    if (expanded === undefined) continue;
    expandedByAnchor.set(descriptor.field, expanded);
    const existingTargets = expandedBySourceField.get(descriptor.sourceField);
    if (existingTargets !== undefined && !sameTargetSources(existingTargets, expanded)) {
      throw new Error(`Incompatible targets for ${descriptor.sourceField}.`);
    }
    expandedBySourceField.set(
      descriptor.sourceField,
      mergeTargets(expandedBySourceField.get(descriptor.sourceField) ?? [], expanded),
    );
  }

  for (const descriptor of [definition.source, ...(definition.source.targets ?? [])]) {
    const explicit = input[descriptor.field];
    if (typeof explicit !== "string" || explicit.length === 0) continue;
    const expanded = await resolveTargets(explicit, descriptor.field, explicit);
    if (expanded !== undefined) {
      expandedFromExplicitSource.add(descriptor.field);
      sourceSelections.set(descriptor.field, expanded);
      expandedBySourceField.set(
        descriptor.field,
        mergeTargets(expandedBySourceField.get(descriptor.field) ?? [], expanded),
      );
    }
  }

  const fields = new Map<string, string>();
  const sourceDescriptors = [definition.source, ...(definition.source.targets ?? [])];
  for (const descriptor of sourceDescriptors) {
    const explicit = input[descriptor.field];
    const explicitSource =
      typeof explicit === "string" && explicit.length > 0 ? explicit : undefined;
    const fallback = "fallbackTo" in descriptor ? fields.get(descriptor.fallbackTo) : undefined;
    let expanded = expandedBySourceField.get(descriptor.field);
    if (expanded !== undefined) {
      if (explicitSource !== undefined && !expandedFromExplicitSource.has(descriptor.field)) {
        const scoped = expanded.filter((target) =>
          sameResource(explicitSource, target.source, context.cwd),
        );

        if (scoped.length === 0) {
          throw new Error(`Anchor does not belong to ${explicitSource}.`);
        }

        if (scoped.length !== expanded.length) {
          expanded = scoped;
          expandedBySourceField.set(descriptor.field, scoped);
          explicitlyScopedSourceFields.add(descriptor.field);
        }
      }
      fields.set(descriptor.field, requiredValue(expanded[0]).source);
      continue;
    }
    // Resource-owning anchors win. Only an omitted primary source may use read history.
    const inherited =
      descriptor.field === definition.source.field &&
      definition.source.inherited === true &&
      !(descriptor.field in input)
        ? lastResolvedSource
        : undefined;
    const source = explicitSource ?? fallback ?? inherited;
    if (source === undefined) throw new Error(`${descriptor.field} is required`);
    fields.set(descriptor.field, source);
  }

  const anchors = new Map<string, readonly string[]>();
  const implicitTargets = new Map<string, readonly TextTarget[]>();
  for (const descriptor of definition.anchors ?? []) {
    const targets = sourceSelections.get(descriptor.sourceField);
    const firstAnchor = definition.anchors?.find(
      (anchor) => anchor.sourceField === descriptor.sourceField,
    );

    const hasExplicitAnchor = isMutationAnchorValue(descriptor, input[descriptor.field]);
    const hasImplicitSourceSelection = expandedFromExplicitSource.has(descriptor.sourceField);
    if (!hasExplicitAnchor && !hasImplicitSourceSelection) continue;
    // A sibling endpoint can identify the file, but must not contribute its
    // selected ranges to this endpoint. Only a typed source supplies a selection.
    if (
      targets !== undefined &&
      hasImplicitSourceSelection &&
      definition.name !== "undo" &&
      descriptor.field === firstAnchor?.field
    ) {
      implicitTargets.set(descriptor.field, targets);
    }
  }

  for (const descriptor of definition.anchors ?? []) {
    const expanded = expandedByAnchor.get(descriptor.field);
    const value = input[descriptor.field];

    if (typeof value === "string" && !isMutationAnchorValue(descriptor, value)) continue;
    const source = fields.get(descriptor.sourceField);
    if (expanded !== undefined) {
      anchors.set(
        descriptor.field,
        source !== undefined &&
          (expanded.length === 1 || explicitlyScopedSourceFields.has(descriptor.sourceField))
          ? [source]
          : [...new Set(expanded.map((target) => target.source))],
      );
    } else if (source !== undefined) {
      const selected = expandedBySourceField.get(descriptor.sourceField);
      const explicitAnchor = input[descriptor.field];
      anchors.set(
        descriptor.field,
        selected !== undefined && typeof explicitAnchor === "string" && explicitAnchor.length > 0
          ? [...new Set(selected.map((target) => target.source))]
          : [source],
      );
    }
  }
  const targets = [...expandedBySourceField.values()]
    .flat()
    .reduce<TextTarget[]>((all, target) => mergeTargets(all, [target]), []);
  return {
    fields,
    anchors,
    implicitTargets,
    targets,
    resources: [...new Set([...fields.values(), ...targets.map((target) => target.source)])],
  };
}

function sameTargetSources(left: readonly TextTarget[], right: readonly TextTarget[]): boolean {
  const leftSources = new Set(left.map((target) => target.source));
  const rightSources = new Set(right.map((target) => target.source));
  return (
    leftSources.size === rightSources.size &&
    [...leftSources].every((source) => rightSources.has(source))
  );
}

function mergeTargets(left: readonly TextTarget[], right: readonly TextTarget[]): TextTarget[] {
  const merged = new Map<string, TextTarget>();
  for (const target of [...left, ...right]) {
    const previous = merged.get(target.source);
    if (previous === undefined) {
      merged.set(target.source, target);
      continue;
    }
    if (
      previous.expectedContent !== undefined &&
      target.expectedContent !== undefined &&
      previous.expectedContent !== target.expectedContent
    )
      throw new Error("Selections refer to different source revisions. Read the source again.");
    const ranges = [...(previous.ranges ?? []), ...(target.ranges ?? [])];
    merged.set(target.source, {
      source: target.source,
      expectedContent: target.expectedContent ?? previous.expectedContent,
      ...(ranges.length > 0 && { ranges: deduplicateRanges(ranges) }),
    });
  }
  return [...merged.values()];
}

function deduplicateRanges(ranges: readonly TextSelectionRange[]): readonly TextSelectionRange[] {
  const merged = new Map<string, TextSelectionRange>();
  for (const range of ranges) {
    const key = JSON.stringify({ start: range.start, end: range.end });
    const previous = merged.get(key);
    merged.set(key, {
      ...range,
      ...(previous?.linewise === true || range.linewise === true ? { linewise: true } : {}),
    });
  }
  return [...merged.values()];
}

function naturalLineSelection(content: string, lineNumber: number): TextSelectionRange {
  const lines = content.split(/\r\n|\r|\n/u);
  const line = lines[lineNumber - 1];
  if (line === undefined) {
    throw new Error(`Position anchor line ${lineNumber} is outside the source.`);
  }
  const hasFollowingLine = lineNumber < lines.length;
  return {
    start: { lineNumber, column: 0 },
    end: hasFollowingLine
      ? { lineNumber: lineNumber + 1, column: 0 }
      : { lineNumber, column: line.length },
    linewise: true,
  };
}

function mergeResolvedAnchors(
  documentFor: (source: string) => TextChangeDocument,
  field: string,
  explicit: ReadonlyMap<string, TextAnchor>,
  implicit: ReadonlyMap<string, TextSelectionAnchor>,
): ReadonlyMap<string, TextAnchor> {
  const sources = new Set([...explicit.keys(), ...implicit.keys()]);
  return new Map(
    [...sources].map((source) => {
      const explicitAnchor = explicit.get(source);
      const implicitAnchor = implicit.get(source);
      if (explicitAnchor === undefined) return [source, requiredValue(implicitAnchor)] as const;
      if (implicitAnchor === undefined) return [source, explicitAnchor] as const;

      const explicitSelection = TextSelectionAnchor.is(explicitAnchor)
        ? explicitAnchor
        : new TextSelectionAnchor(field, source, [
            naturalLineSelection(documentFor(source).content, explicitAnchor.lineNumber),
          ]);
      const ranges = [...explicitSelection.ranges, ...implicitAnchor.ranges].sort(
        (left, right) =>
          left.start.lineNumber - right.start.lineNumber || left.start.column - right.start.column,
      );
      const unique = deduplicateRanges(ranges);
      for (let index = 1; index < unique.length; index++) {
        const previous = requiredValue(unique[index - 1]);
        const current = requiredValue(unique[index]);
        if (
          current.start.lineNumber < previous.end.lineNumber ||
          (current.start.lineNumber === previous.end.lineNumber &&
            current.start.column < previous.end.column)
        ) {
          throw new Error(`Anchor ${field} selections overlap or are ambiguous.`);
        }
      }
      return [source, new TextSelectionAnchor(field, source, unique)] as const;
    }),
  );
}
interface MutationExecutionContext extends TextMutationContext {
  resultPresentationFor(source: string): MutationResultPresentation;
}

interface ExecutedTextMutation extends TextMutation {
  readonly resultPresentations: ReadonlyMap<string, MutationResultPresentation>;
  readonly unchangedWrite?: { readonly source: string; readonly content: string };
}

function createMutationContext(
  definition: TextMutationToolRegistration,
  input: Readonly<Record<string, unknown>>,
  invocation: { readonly cwd: string; readonly signal?: AbortSignal },
  sources: ResolvedMutationSources,
  texts: ReadonlyMap<string, string>,
  resolveResourceAnchor: ResolveResourceTextAnchor,
  publishAnchorRenderState?: (field: string, state: ToolCallAnchorRenderState) => void,
): MutationExecutionContext {
  const documents = new Map(
    [...texts].map(([source, text]) => [source, new TextChangeDocument(text)]),
  );
  const anchorCache = new Map<string, Promise<ReadonlyMap<string, TextAnchor>>>();

  const majorAnchorSources = new Set<string>();
  const sourceFor = (field: string): string => {
    const source = sources.fields.get(field);

    if (source === undefined) {
      throw new Error(`Unknown mutation source field ${field}`);
    }

    return source;
  };
  const documentFor = (source: string): TextChangeDocument => {
    const document = documents.get(source);

    if (document === undefined) {
      throw new Error(`Unknown mutation resource ${source}`);
    }

    return document;
  };
  const resolveAnchors = (field: string): Promise<ReadonlyMap<string, TextAnchor>> => {
    const cached = anchorCache.get(field);

    if (cached !== undefined) {
      return cached;
    }

    const pending = (async () => {
      const descriptor = (definition.anchors ?? []).find((anchor) => anchor.field === field);
      const value = input[field];
      const anchorSources = sources.anchors.get(field);
      const implicitTargets = sources.implicitTargets.get(field);

      if (descriptor === undefined) {
        throw new Error(
          `Mutation tool ${definition.name} tried to resolve undeclared anchor ${field}`,
        );
      }

      const explicitAnchors =
        typeof value === "string" && anchorSources !== undefined
          ? new Map(
              await Promise.all(
                anchorSources.map(async (source) => {
                  try {
                    const anchor = await resolveResourceAnchor(source, value, descriptor.kinds);

                    if (resolvedTextAnchorType(anchor) === "major") {
                      majorAnchorSources.add(source);
                    }
                    const rendered = renderTextAnchor(anchor, value, { source, anchor });
                    publishAnchorRenderState?.(field, {
                      kind: "resolved",
                      full: rendered.full,
                      compact: rendered.compact,
                      resolverId: rendered.resolverId,
                    });
                    return [source, anchor] as const;
                  } catch (error) {
                    publishAnchorRenderState?.(field, { kind: "failed" });
                    throw contextualizeTextMutationAnchorError(
                      error,
                      definition.name,
                      field,
                      source,
                      value,
                    );
                  }
                }),
              ),
            )
          : undefined;

      if (implicitTargets !== undefined) {
        const implicit = new Map(
          implicitTargets.map(
            (target) =>
              [
                target.source,
                new TextSelectionAnchor(field, target.source, target.ranges ?? []),
              ] as const,
          ),
        );
        if (explicitAnchors === undefined) return implicit;
        return mergeResolvedAnchors(documentFor, field, explicitAnchors, implicit);
      }

      if (explicitAnchors === undefined) {
        throw new Error(
          `Mutation tool ${definition.name} tried to resolve undeclared anchor ${field}`,
        );
      }
      return explicitAnchors;
    })();
    anchorCache.set(field, pending);
    return pending;
  };

  return {
    cwd: invocation.cwd,
    ...(invocation.signal !== undefined && { signal: invocation.signal }),
    sourceDocument: documentFor(sourceFor(definition.source.field)),
    sourceFor,
    documentFor,
    targetDocument(field): TextChangeDocument {
      if ((definition.source.targets ?? []).every((target) => target.field !== field)) {
        throw new Error(
          `Mutation tool ${definition.name} tried to access undeclared target ${field}`,
        );
      }

      return documentFor(sourceFor(field));
    },
    resolveAnchors,
    async resolveAnchor(field): Promise<TextAnchor> {
      const resolved = await resolveAnchors(field);

      if (resolved.size !== 1) {
        throw new Error(
          `Anchor ${field} selects multiple resources; use an operation that supports a search set.`,
        );
      }

      return requiredValue(resolved.values().next().value);
    },

    resultPresentationFor(source): MutationResultPresentation {
      return [...majorAnchorSources].some((candidate) =>
        sameResource(candidate, source, invocation.cwd),
      )
        ? "major-anchor"
        : "plain";
    },
  };
}

function withResultPresentations(
  mutation: TextMutation,
  context: MutationExecutionContext,
): ExecutedTextMutation {
  return {
    ...mutation,
    resultPresentations: new Map(
      [...mutation.edits.keys()].map((source) => [source, context.resultPresentationFor(source)]),
    ),
  };
}

const preflightMutationTools = new Set(["replace", "delete", "insert", "copy", "move"]);
/** Resolves every supplied anchor field for built-in span mutation tools. */
export async function preflightMutationAnchors(
  definition: TextMutationToolRegistration,
  input: Readonly<Record<string, unknown>>,
  context: TextMutationContext,
): Promise<void> {
  if (!preflightMutationTools.has(definition.name)) {
    return;
  }
  const failures: TextMutationAnchorResolutionError[] = [];
  await Promise.all(
    (definition.anchors ?? []).map(async (descriptor) => {
      if (!isMutationAnchorValue(descriptor, input[descriptor.field])) {
        return;
      }
      try {
        await context.resolveAnchors(descriptor.field);
      } catch (error) {
        if (error instanceof TextMutationAnchorResolutionError) {
          failures.push(error);
          return;
        }
        throw error;
      }
    }),
  );
  if (failures.length > 0) {
    throw new TextMutationAnchorAggregateError(failures);
  }
}

function sameResource(left: string, right: string, cwd: string): boolean {
  return resourceIdentity(left, cwd) === resourceIdentity(right, cwd);
}

function resourceIdentity(source: string, cwd: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(source)) {
    return source;
  }

  const fileSource = source.startsWith("@") ? source.slice(1) : source;
  return path.resolve(cwd, fileSource);
}

export async function previewTextMutation(
  core: TextEditorCore,
  request: TextMutationPreviewRequest,
): Promise<TextMutationPreviewOutcome> {
  const definition = core.getMutationTools().find((candidate) => candidate.name === request.tool);

  if (definition === undefined) {
    return { kind: "failed", reason: `Unknown mutation tool ${request.tool}` };
  }

  try {
    const sources = await resolveMutationSources(core, definition, request.input, request);
    const semanticHandler = core.getSemanticMutationHandler(definition.name, request.input);
    return await core.previewTexts(
      sources.resources.map((source) => ({
        source,
        read: true,
        ...(semanticHandler === undefined
          ? definition.name === "write" && { allowReadFailure: true }
          : { requireWrite: false }),
      })),
      { cwd: request.cwd, ...(request.signal !== undefined && { signal: request.signal }) },
      async (texts, resolveAnchor) => {
        const mutationContext = createMutationContext(
          definition,
          request.input,
          request,
          sources,
          texts,
          resolveAnchor,
        );
        await preflightMutationAnchors(definition, request.input, mutationContext);
        if (semanticHandler !== undefined) {
          return { changes: new Map(), result: { edits: new Map() } };
        }
        const mutation = await definition.mutate(mutationContext, request.input);

        return {
          changes: new Map([...mutation.edits].map(([source, edit]) => [source, edit.changes])),
          result: mutation,
        };
      },
    );
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Executes a mutation, using read history only when neither a source nor an anchor owns it. */
export async function executeTextMutation<TParameters extends TSchema>(
  core: TextEditorCore,
  definition: TextMutationToolRegistration<TParameters>,
  parameters: Static<TParameters>,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
  publishAnchorRenderState?: (field: string, state: ToolCallAnchorRenderState) => void,
  lastResolvedSource?: string,
): Promise<AgentToolResult<FileMutationBatchResult>> {
  const execution = await executeTextMutationPipeline(
    core,
    definition,
    parameters,
    signal,
    context,
    publishAnchorRenderState,
    lastResolvedSource,
  );
  const result = await buildToolResult(
    core,
    execution.pipeline,
    execution.source,
    context,
    definition.name,
  );
  return execution.pipeline.kind === "completed" && execution.pipeline.state.metadata !== undefined
    ? { ...result, details: { ...result.details, metadata: execution.pipeline.state.metadata } }
    : result;
}

/** Runs configured mutation semantics without creating model-facing presentation. */
export async function executeTextMutationPipeline<TParameters extends TSchema>(
  core: TextEditorCore,
  definition: TextMutationToolRegistration<TParameters>,
  parameters: Static<TParameters>,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
  publishAnchorRenderState?: (field: string, state: ToolCallAnchorRenderState) => void,
  lastResolvedSource?: string,
): Promise<{ readonly pipeline: TextEditExecutionOutcome; readonly source: string }> {
  const source = mutationSource(definition, parameters);
  const pipeline = await core.executeEdit(
    definition.name,
    {
      cwd: context.cwd,
      input: parameters,
      ...(signal !== undefined && { signal }),
    },
    async (state) => {
      try {
        if (state.editPlan !== undefined) {
          const plan = state.editPlan;
          if (
            plan.files.length === 0 ||
            new Set(plan.files.map((file) => file.source)).size !== plan.files.length
          )
            throw new Error("Semantic edit plan must contain distinct source files.");
          const outcome = await core.editTexts(
            plan.files.map((file) => ({ source: file.source, read: true })),
            {
              cwd: state.cwd,
              intent: definition.intent ?? "edit",
              ...(state.signal !== undefined && { signal: state.signal }),
            },
            (texts) => {
              for (const file of plan.files) {
                if (texts.get(file.source) !== file.expectedContent)
                  throw new Error(
                    "A semantic edit source changed. Resolve the symbol again before retrying.",
                  );
              }
              const edits = new Map(
                plan.files.map((file) => [
                  file.source,
                  { changes: file.changes, action: "edited" as const },
                ]),
              );
              return Promise.resolve({
                changes: new Map(plan.files.map((file) => [file.source, file.changes])),
                result: {
                  edits,
                  resultPresentations: new Map(
                    plan.files.map((file) => [file.source, "plain" as const]),
                  ),
                },
              });
            },
          );
          return await completeTextMutation(outcome, requiredValue(plan.files[0]).source);
        }
        const sources = await resolveMutationSources(
          core,
          definition,
          state.input,
          state,
          lastResolvedSource,
        );
        const semanticHandler = core.getSemanticMutationHandler(definition.name, state.input);
        if (semanticHandler !== undefined) {
          return await core.editTexts(
            sources.resources.map((resourceSource) => ({
              source: resourceSource,
              read: true,
              requireWrite: false,
            })),
            {
              cwd: state.cwd,
              intent: definition.intent ?? "edit",
              ...(state.signal !== undefined && { signal: state.signal }),
            },
            async (texts, resolveAnchor) => {
              for (const target of sources.targets) {
                if (
                  target.expectedContent !== undefined &&
                  texts.get(target.source) !== target.expectedContent
                ) {
                  throw new Error(
                    "The selected source changed before the semantic action. Resolve it again.",
                  );
                }
              }
              const mutationContext = createMutationContext(
                definition,
                state.input,
                state,
                sources,
                texts,
                resolveAnchor,
                publishAnchorRenderState,
              );
              await preflightMutationAnchors(definition, state.input, mutationContext);
              const semanticAction = await semanticHandler.execute(mutationContext, state.input);
              return {
                changes: new Map(),
                result: withResultPresentations(
                  { edits: new Map(), semanticAction },
                  mutationContext,
                ),
                resourceEffect: true,
              };
            },
          );
        }
        const outcome = await core.editTexts(
          sources.resources.map((resourceSource) => ({
            source: resourceSource,
            read: true,
            ...(definition.name === "write" && { allowReadFailure: true }),
          })),
          {
            cwd: state.cwd,
            intent: definition.intent ?? "edit",
            ...(state.signal !== undefined && { signal: state.signal }),
          },
          async (texts, resolveAnchor) => {
            for (const target of sources.targets) {
              if (
                target.expectedContent !== undefined &&
                texts.get(target.source) !== target.expectedContent
              )
                throw new Error(
                  "The selected source changed before editing. Resolve the symbol again.",
                );
            }
            const mutationContext = createMutationContext(
              definition,
              state.input,
              state,
              sources,
              texts,
              resolveAnchor,
              publishAnchorRenderState,
            );
            await preflightMutationAnchors(definition, state.input, mutationContext);
            const mutation = await definition.mutate(mutationContext, state.input);
            const executedMutation: ExecutedTextMutation = {
              ...withResultPresentations(mutation, mutationContext),
              ...(definition.name === "write" && {
                unchangedWrite: {
                  source: mutationContext.sourceFor("path"),
                  content: mutationContext.sourceDocument.content,
                },
              }),
            };
            return {
              changes: new Map(
                [...mutation.edits].map(([editSource, edit]) => [editSource, edit.changes]),
              ),
              result: executedMutation,
            };
          },
        );
        return await completeTextMutation(outcome, mutationSource(definition, state.input));
      } catch (error) {
        return failedResourceEdit(
          mutationSource(definition, state.input),
          "INVALID_REQUEST",
          errorMessage(error),
          error,
        );
      }
    },
  );

  return { pipeline, source };
}

const scriptMutationScope = new AsyncLocalStorage<TextEditCompletion[]>();

/** Capture actual completed effects across a tool or batch, including failed post-edit hooks. */
export async function captureScriptMutation<T>(core: TextEditorCore, action: () => Promise<T>) {
  const completions: TextEditCompletion[] = [];
  const unsubscribe = core.onDidEdit((completion) => {
    if (scriptMutationScope.getStore() === completions) completions.push(completion);
  });
  try {
    const value = await scriptMutationScope.run(completions, action);
    return { kind: "completed" as const, value, completions };
  } catch (error) {
    return { kind: "failed" as const, error, completions };
  } finally {
    unsubscribe();
  }
}
export function mutationSources(
  definition: TextMutationToolRegistration,
  parameters: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  const primary = parameters[definition.source.field];

  if (typeof primary !== "string" || primary.length === 0) {
    throw new Error(`${definition.source.field} is required`);
  }

  sources.set(definition.source.field, primary);

  for (const target of definition.source.targets ?? []) {
    const explicit = parameters[target.field];
    const fallback = sources.get(target.fallbackTo);
    const source = typeof explicit === "string" && explicit.length > 0 ? explicit : fallback;

    if (source === undefined) {
      throw new Error(`${target.field} is required`);
    }

    sources.set(target.field, source);
  }

  return sources;
}

type CompletedTextResource = Extract<
  TextResourceEditOutcome<unknown>,
  { readonly kind: "completed" }
>;

/** Count real Copy changes without counting retained identical destination ranges. */
export function textMutationOperationReceipts(
  operation: string,
  edit: TextMutationEdit,
  before: string,
): readonly MutationOperationReceipt[] {
  const changes =
    operation === "copy"
      ? edit.changes.filter(
          (change) =>
            !change.allowUnchanged || before.slice(change.from, change.to) !== change.insert,
        ).length
      : edit.changes.length;
  return operation === "copy" && changes === 0 ? [] : [{ operation, changes }];
}
/** Builds a mutation receipt; peer ranges are supplied only for per-call batch display results. */
export function buildSuccessfulTextMutationResult(
  resource: CompletedTextResource,
  resultSource: string,
  edit: TextMutationEdit,
  diffAfterContent = resource.after.content,
  resultPresentation: MutationResultPresentation = "plain",
  editCount = 1,
  operations: readonly MutationOperationReceipt[] = [],

  diffPeerRanges?: readonly {
    readonly from: number;
    readonly to: number;
    readonly insert: string;
  }[],
): FileMutationResult {
  const before = resource.before.content;
  const finalAfter = resource.after.content;
  const applied = applyTextChanges(before, edit.changes, before.length === 0);
  const unified = createUnifiedDiff(resultSource, before, diffAfterContent);
  const mutationResultData = resource.postEditContributions
    .map((contribution) => contribution.data)
    .find(isTextMutationResultContributionData);
  const rawChanges = applied.changes.map((change, editIndex) => ({
    editIndex,
    fromA: change.fromBefore,
    toA: change.toBefore,
    fromB: change.fromAfter,
    toB: change.toAfter,
    removedText: change.removedText,
    insertedText: change.insertedText,
  }));

  return new FileMutationResult({
    ...mutationResultData,

    ...(diffPeerRanges === undefined ? {} : { diffPeerRanges }),

    operations,
    diffStatuses: resource.postEditContributions
      .map((item) => item.data)
      .filter(isDiffStatusContribution)
      .flatMap((item) => item.diffStatuses),
    formatting: resource.postEditContributions
      .map((item) => item.data)
      .findLast(isFormattingContribution)?.formatting ?? { status: "not-reported" },
    ok: true,
    path: resultSource,
    diffs: [unified.diff],
    files: [{ path: resultSource, action: edit.action }],
    editCount,
    addedLines: unified.stats.added,
    removedLines: unified.stats.removed,
    beforeContentMap: { [resultSource]: before },
    afterContent: finalAfter,
    rawChanges,
    afterDocument: resource.after,

    resultPresentation,
  });
}

/** Aggregate a failed follow-up with text writes that have already completed. */
export function postWriteFailureEffect(error: unknown): "applied" | "unknown" {
  return error !== null &&
    typeof error === "object" &&
    "effect" in error &&
    (error.effect === "applied" || error.effect === "not-applied")
    ? "applied"
    : "unknown";
}
async function completeTextMutation(
  outcome: TextResourcesEditOutcome<TextMutation>,
  source: string,
): Promise<TextResourcesEditOutcome<TextMutation>> {
  if (outcome.kind === "failed" || outcome.result.afterWrite === undefined) {
    return outcome;
  }

  try {
    await outcome.result.afterWrite();
    return outcome;
  } catch (error) {
    return {
      kind: "failed",
      failure: {
        code: "POST_WRITE_FAILED",
        source,
        message: `Post-write action failed for ${source}`,
        cause: error,
      },
      completed: outcome.resources.map((resource) => resource.source),
    };
  }
}

async function buildToolResult(
  core: TextEditorCore,
  pipeline: TextEditExecutionOutcome,
  source: string,
  context: ExtensionContext,
  operation: string,
): Promise<AgentToolResult<FileMutationBatchResult>> {
  if (pipeline.kind === "failed") {
    return failureToolResult(
      source,
      pipeline.failure.code,
      pipeline.failure.message,
      pipeline.failure.stage === "text-pre-edit" ? "not-applied" : "unknown",
    );
  }

  const outcome = pipeline.state.result;

  if (!isResourcesEditOutcome(outcome)) {
    return failureToolResult(
      source,
      "INVALID_RESULT",
      "Text editor returned an invalid edit result.",
      "unknown",
    );
  }

  if (outcome.kind === "failed") {
    const recovery = await anchorFailureToolResult(core, outcome.failure, context);

    if (recovery !== undefined) {
      return recovery;
    }

    if (operation === "copy" && outcome.failure.code === "WRITE_FAILED") {
      return buildFailedCopyWriteResult(outcome.failure, outcome.completed);
    }
    const safe = outcome.failure.cause instanceof ResourceError ? outcome.failure.cause : undefined;
    const completed =
      outcome.completed.length === 0 ? "" : ` Completed writes: ${outcome.completed.join(", ")}.`;
    const uncertainWrite = hasUnknownMutationEffect(outcome.failure.cause);
    const effect = uncertainWrite
      ? "unknown"
      : outcome.failure.code === "POST_WRITE_FAILED"
        ? postWriteFailureEffect(outcome.failure.cause)
        : outcome.completed.length > 0
          ? "applied"
          : (safe?.effect ?? "not-applied");
    const reason =
      safe === undefined
        ? outcome.failure.message
        : `${safe.code}: ${source}${safe.effect === "unknown" ? "; inspect the resource before retrying" : ""}`;
    const message = `${reason.replace(/[.!?]+$/u, "")}.${completed}`;
    return safe === undefined
      ? buildFailedTextMutationResult(core, { ...outcome.failure, message }, context, effect)
      : failureToolResult(source, safe.code, message, effect, outcome.failure.rollback);
  }

  const mutation = outcome.result as ExecutedTextMutation;
  if (mutation.semanticAction !== undefined) {
    return {
      content: [{ type: "text", text: mutation.semanticAction.summary }],
      details: {
        results: [],
        metadata: {
          semanticAction: {
            ...mutation.semanticAction.data,
            source: mutation.semanticAction.source,
          },
        },
      },
    };
  }
  if (operation === "write" && outcome.resources.length === 0 && mutation.unchangedWrite) {
    const { source: unchangedSource, content } = mutation.unchangedWrite;
    return {
      content: [
        {
          type: "text",
          text: `File already matches the supplied content. Nothing was written.\nPost-edit processing was skipped.\n\n${unchangedSource}`,
        },
      ],
      details: {
        effect: "not-applied",
        results: [
          new FileMutationResult({
            ok: true,
            path: unchangedSource,
            afterContent: content,
            rawChanges: [],
          }),
        ],
      },
    };
  }
  const results = outcome.resources.flatMap((resource) => {
    const resultSource = resource.source;
    const edit = mutation.edits.get(resultSource);
    return edit === undefined
      ? []
      : [
          buildSuccessfulTextMutationResult(
            resource,
            resultSource,
            edit,
            undefined,
            mutation.resultPresentations.get(resultSource) ?? "plain",

            1,
            textMutationOperationReceipts(operation, edit, resource.before.content),
          ),
        ];
  });

  const presented = results.map((result) => withPipelineStatuses(result, pipeline.state.metadata));
  return {
    content: [new FileMutationAgentResult(presented).toTextContent()],
    details: { results: presented },
  };
}

function withPipelineStatuses(result: FileMutationResult, metadata: unknown): FileMutationResult {
  if (!isDiffStatusContribution(metadata)) return result;
  return new FileMutationResult({
    ...result.data,
    diffStatuses: [...(result.data.diffStatuses ?? []), ...metadata.diffStatuses],
  });
}
async function resolveAnchorRecovery(error: TextMutationAnchorResolutionError) {
  if (error.resolution.recovery === undefined) await error.resolution.refreshRecovery();
  return error.resolution.recovery;
}

async function anchorFailureToolResult(
  core: TextEditorCore,
  failure: TextResourceEditFailure,
  context: ExtensionContext,
): Promise<AgentToolResult<FileMutationBatchResult> | undefined> {
  if (failure.cause instanceof TextMutationAnchorAggregateError) {
    const recovered = await Promise.all(
      failure.cause.failures.map((cause) =>
        anchorFailureToolResult(core, { ...failure, source: cause.source, cause }, context),
      ),
    );
    const results: FileMutationResult[] = [];
    const anchorRecoveries: NonNullable<FileMutationBatchResult["anchorRecoveries"]>[number][] = [];
    const messages: string[] = [];
    const exactTextFailures: string[] = [];
    for (const item of recovered) {
      if (item === undefined) {
        continue;
      }
      results.push(...(item.details.results ?? []));
      anchorRecoveries.push(...(item.details.anchorRecoveries ?? []));
      const failed = item.details.metadata?.exactTextFailures;
      if (Array.isArray(failed))
        exactTextFailures.push(
          ...failed.filter((source): source is string => typeof source === "string"),
        );
      for (const block of item.content) {
        if (block.type === "text") {
          messages.push(block.text);
        }
      }
    }
    if (results.length === 0) {
      return undefined;
    }
    return {
      content: [{ type: "text", text: messages.join("\n\n") }],
      details: {
        results,
        anchorRecoveries,
        effect: "not-applied",
        metadata: { exactTextFailures },
      },
    };
  }
  if (!(failure.cause instanceof TextMutationAnchorResolutionError)) {
    return undefined;
  }

  const contextual = failure.cause;
  const resolution = contextual.resolution;
  const recovery = await resolveAnchorRecovery(contextual).catch(() => {
    context.signal?.throwIfAborted();
    return undefined;
  });

  const windows =
    recovery?.kind === "candidates"
      ? recoveryWindows(
          recovery.candidates.map(({ range }) => range),
          core.recoveryContextLines(),
        )
      : resolution.rejection?.contextRange === undefined
        ? []
        : [resolution.rejection.contextRange];
  if (windows.length === 0) windows.push({ offset: 1, limit: 40 });

  const reads = await Promise.all(
    windows.map((range) =>
      readTextAnchorRecovery(
        core,
        { path: contextual.source, ...range },
        {
          cwd: context.cwd,
          ...(context.signal !== undefined && { signal: context.signal }),
        },
      )?.catch(() => {
        context.signal?.throwIfAborted();
        return undefined;
      }),
    ),
  );
  const recoveryTexts: string[] = [];
  for (const read of reads) {
    if (read === undefined || read.isError === true) continue;
    recoveryTexts.push(
      ...read.content.filter((block) => block.type === "text").map((block) => block.text),
    );
  }

  const result = new FileMutationResult({
    ok: false,
    path: contextual.source,
    errors: [
      {
        path: contextual.source,
        code: resolution.rejection?.code ?? failure.code,
        reason: resolution.message,
      },
    ],
  });
  const recoveryContext = recoveryTexts.join("\n");
  const rejectionCode = resolution.rejection?.code;
  const content =
    rejectionCode === "stale"
      ? formatStaleAnchorMessage(
          {
            guardId: "stale-anchor",
            effect: "not-applied",
            toolName: contextual.toolName,
            field: contextual.field,
            path: contextual.source,
            anchor: contextual.anchor,
            ...(recoveryContext.length > 0 && { context: recoveryContext }),
          } satisfies StaleAnchorMessageDetails,
          resolution.message,
        )
      : formatRejectedAnchorMessage(contextual, rejectionCode, resolution.message, recoveryContext);

  return {
    content: [{ type: "text", text: content }],
    details: {
      results: [result],
      effect: "not-applied",
      anchorRecovery: true,
      ...(resolution.resolverId === "exact-text" && {
        metadata: { exactTextFailures: [contextual.source] },
      }),
      ...(recovery?.kind === "candidates" && {
        anchorRecoveries: [
          {
            field: contextual.field,
            path: contextual.source,
            anchor: contextual.anchor,
            total: recovery.total,
            candidates: recovery.candidates,
          },
        ],
      }),
    } as FileMutationBatchResult,
  };
}

function formatRejectedAnchorMessage(
  failure: TextMutationAnchorResolutionError,
  code: TextAnchorRejection["code"] | undefined,
  reason: string,
  recoveryContext: string,
): string {
  const state =
    code === "ambiguous"
      ? "is ambiguous"
      : code === "missing"
        ? "was not found"
        : code === "invalid"
          ? "was rejected"
          : "could not be resolved";
  const guidance =
    failure.resolution.resolverId === "exact-text"
      ? failure.toolName === "copy"
        ? "Use an anchor below, or get a fresh Read/Search selection and pass it to Copy."
        : "Exact-text edits are blocked for this file. Use a current anchor below for the intended edit, or get one with Read/Search. Exact text is available again after that edit succeeds."
      : "If the intended text is represented below, use its candidate anchor. Otherwise, reread the relevant section and choose a current anchor.";
  const context = recoveryContext.length === 0 ? "" : `\n\n${recoveryContext}`;
  return `[SYSTEM] ${failure.toolName} blocked: ${failure.field === "anchor" ? "anchor" : `${failure.field} anchor`} "${failure.anchor}" ${state}. ${guidance} (${reason})${context}`;
}

function recoveryWindows(
  ranges: readonly TextAnchorRecoveryCandidateRange[],
  contextLines: number,
): TextAnchorRecoveryRange[] {
  const windows = ranges
    .map((range) => ({
      offset: Math.max(1, range.start.lineNumber - contextLines),
      limit: range.end.lineNumber - range.start.lineNumber + 1 + contextLines * 2,
    }))
    .sort((left, right) => left.offset - right.offset);
  const merged: TextAnchorRecoveryRange[] = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous === undefined || window.offset > previous.offset + previous.limit) {
      merged.push(window);
      continue;
    }
    const end = Math.max(previous.offset + previous.limit, window.offset + window.limit);
    merged[merged.length - 1] = { offset: previous.offset, limit: end - previous.offset };
  }
  return merged;
}

export async function buildFailedTextMutationResult(
  core: TextEditorCore,
  failure: TextResourceEditFailure,
  context: ExtensionContext,
  effect: "applied" | "not-applied" | "unknown" = "not-applied",
): Promise<AgentToolResult<FileMutationBatchResult>> {
  if (failure.rollback !== undefined) {
    return failureToolResult(
      failure.source,
      failure.code,
      failure.message,
      failure.rollback.failed.length === 0 && failure.rollback.originallyMissing.length === 0
        ? "not-applied"
        : "unknown",
      failure.rollback,
    );
  }
  return effect === "not-applied"
    ? ((await anchorFailureToolResult(core, failure, context)) ??
        failureToolResult(failure.source, failure.code, failure.message, effect, failure.rollback))
    : failureToolResult(failure.source, failure.code, failure.message, effect, failure.rollback);
}

/** Report Copy rollback evidence without claiming that an unverified destination is unchanged. */
export function buildFailedCopyWriteResult(
  failure: TextResourceEditFailure,
  unrestoredSources: readonly string[],
): AgentToolResult<FileMutationBatchResult> {
  const uncertainWrite = hasUnknownMutationEffect(failure.cause);
  const rollbackFailed =
    uncertainWrite ||
    (failure.rollback === undefined
      ? unrestoredSources.length > 0
      : failure.rollback.failed.length > 0 || failure.rollback.originallyMissing.length > 0);
  const effect = rollbackFailed ? "unknown" : "not-applied";
  const result = new FileMutationResult({
    ok: false,
    path: failure.source,
    errors: [{ path: failure.source, code: failure.code, reason: failure.message }],
    fileChangedStatement: uncertainWrite
      ? "Copy failed, and its effects are unknown. Read the affected destinations before retrying."
      : rollbackFailed
        ? "Rollback failed. Read the listed destinations before retrying."
        : "Copy failed. Destination changes were rolled back.",
  });
  return {
    content: [new FileMutationAgentResult(result).toTextContent()],
    details: {
      results: [result],
      effect,
      metadata: { copyRollback: rollbackFailed ? "failed" : "restored" },
    },
  };
}
function hasUnknownMutationEffect(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && "effect" in error && error.effect === "unknown"
  );
}
function declaredMutationEffect(error: unknown): "applied" | "not-applied" | "unknown" {
  if (
    error !== null &&
    typeof error === "object" &&
    "effect" in error &&
    (error.effect === "applied" || error.effect === "not-applied" || error.effect === "unknown")
  )
    return error.effect;
  return "unknown";
}
function failureToolResult(
  source: string,
  code: string,
  reason: string,
  effect: "not-applied" | "applied" | "unknown",
  rollback?: TextResourceEditFailure["rollback"],
  copyExecutionFailure = false,
): { content: [{ type: "text"; text: string }]; details: FileMutationBatchResult } {
  const uncertain =
    effect === "unknown" ||
    (rollback !== undefined &&
      (rollback.failed.length > 0 || rollback.originallyMissing.length > 0));
  const fileChangedStatement =
    rollback === undefined
      ? effect === "applied"
        ? "The edit was saved, but a post-write step failed. Run Read/Search before editing this resource again."
        : effect === "unknown"
          ? "The operation failed, and its effects are unknown. Read the affected resources before retrying."
          : undefined
      : effect === "unknown" &&
          rollback.failed.length === 0 &&
          rollback.originallyMissing.length === 0
        ? "Confirmed peer writes were rolled back, but another write has unknown effects. Read the affected resources before retrying."
        : rollback.originallyMissing.length > 0
          ? "The file may now exist. Read the path before retrying."
          : uncertain
            ? `Rollback failed for ${rollback.failed.join(", ")}. Current contents are unknown. Run Read/Search before editing these resources again.`
            : "Attempted writes were rolled back.";
  const result = new FileMutationResult({
    ok: false,
    path: source,
    errors: [{ path: source, code, reason }],
    ...(fileChangedStatement === undefined ? {} : { fileChangedStatement }),
    ...(rollback !== undefined && {
      rollback: {
        failedSources: [...new Set([...rollback.failed, ...rollback.originallyMissing])],
      },
    }),
    ...(copyExecutionFailure && {
      fileChangedStatement:
        "Copy failed. Its effects are uncertain. Read the affected destinations before retrying.",
    }),
  });

  return {
    content: [new FileMutationAgentResult(result).toTextContent()],
    details: {
      results: [result],
      effect: rollback === undefined ? effect : uncertain ? "unknown" : "not-applied",
      ...(rollback === undefined
        ? {}
        : { metadata: { rollback: uncertain ? "uncertain" : "restored" } }),
      ...(copyExecutionFailure && { metadata: { copyExecution: "uncertain" } }),
    },
  };
}

function failedResourceEdit(
  source: string,
  code: TextResourceEditFailure["code"],
  message: string,
  cause?: unknown,
): TextResourcesEditOutcome<never> {
  return {
    kind: "failed",
    failure: { code, source, message, ...(cause !== undefined && { cause }) },
    completed: [],
  };
}

function isResourcesEditOutcome(value: unknown): value is TextResourcesEditOutcome<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { kind?: unknown }).kind === "completed" ||
      (value as { kind?: unknown }).kind === "failed")
  );
}

function asMutationParameters<TParameters extends TSchema>(value: unknown): Static<TParameters> {
  // oxlint-disable-next-line typescript/no-unsafe-return -- TypeBox resolves only concrete tool schemas.
  return value as Static<TParameters>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
