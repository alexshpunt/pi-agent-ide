import { requiredValue } from "pi-agent-invariant";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TextEditCompletion } from "#src/api/edit-completion.js";
import { Value } from "typebox/value";
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
import type { ScriptMutationOutcome } from "#src/core/apply/mutation-outcome.js";

export function createTextTool<TParameters extends TSchema>(
  core: TextEditorCore,
  definition: TextMutationToolRegistration<TParameters>,
  annotations: ToolCallInterceptionRenderStore,
  pluginPromptGuideline: () => string | undefined,
  getLastResolvedSource: () => string | undefined,
): ToolDefinition<TParameters, FileMutationBatchResult> {
  const renderer = core.getToolRenderer(definition.name);
  const initialRenderCall = renderer?.renderCall;
  const initialRenderResult = renderer?.renderResult;

  const tool = withToolCallInterceptionRendering<TParameters, FileMutationBatchResult, unknown>(
    defineTool<TParameters, FileMutationBatchResult, unknown>({
      name: definition.name,
      label: definition.name,

      promptSnippet: definition.promptSnippet,
      promptGuidelines:
        definition.promptGuidelines === undefined ? undefined : [...definition.promptGuidelines],
      description: definition.description,
      parameters: definition.parameters,
      prepareArguments: (arguments_) =>
        // oxlint-disable-next-line typescript/no-unsafe-return -- TypeBox resolves only concrete tool schemas.
        prepareGuardedArguments(
          definition.parameters,
          arguments_,
          definition.source.inherited ? definition.source.field : undefined,
          getLastResolvedSource(),
          definition.anchors ?? [],
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
        const directExecute = () =>
          executeTextMutation(
            core,
            definition,
            asMutationParameters<TParameters>(parameters),
            signal,
            context,
            (field, state) =>
              annotations.resolveArguments(toolCallId, {
                [TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH]: { [field]: state },
              }),
            getLastResolvedSource(),
          );
        return executeTextToolWithBatch(toolCallId, directExecute, signal, onUpdate, context);
      },
    }),
    annotations,
  );
  Object.defineProperty(tool, "description", {
    enumerable: true,
    get(): string {
      return [
        definition.description,
        definition.source.inherited
          ? `When ${definition.source.field} is omitted, the tool can reuse the file identified by the supplied anchor, the last read, or the preceding edit in the same batch.`
          : "",
        pluginPromptGuideline() ?? "",
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
    !hasExplicitAnchor
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
      return await core.resolveTextAnchorResources(value, allKinds, context);
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
    return await core.previewTexts(
      sources.resources.map((source) => ({
        source,
        read: true,
        ...(definition.name === "write" && { allowReadFailure: true }),
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
            const executedMutation = withResultPresentations(mutation, mutationContext);
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

async function captureScriptMutation<T>(core: TextEditorCore, action: () => Promise<T>) {
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
/**
 * Runs the configured mutation pipeline and returns plain script data.
 * onPresentation retains rich edit annotations on the host without sending classes to the guest.
 */
export async function executeScriptMutation<TParameters extends TSchema>(
  core: TextEditorCore,
  definition: TextMutationToolRegistration<TParameters>,
  arguments_: unknown,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
  lastResolvedSource?: string,
  onPresentation?: (source: string, result: FileMutationResult) => void,
): Promise<ScriptMutationOutcome> {
  const parameters = prepareGuardedArguments(
    definition.parameters,
    arguments_,
    definition.source.inherited ? definition.source.field : undefined,
    lastResolvedSource,
    definition.anchors ?? [],
  );
  if (!Value.Check(definition.parameters, parameters)) {
    throw Object.assign(new Error(`Invalid arguments for ${definition.name}`), {
      code: "INVALID_ARGUMENTS",
      details: { operation: definition.name, effect: "not-applied" },
    });
  }
  const captured = await captureScriptMutation(core, () =>
    executeTextMutationPipeline(
      core,
      definition,
      parameters,
      signal,
      context,
      undefined,
      lastResolvedSource,
    ),
  );
  const source =
    captured.kind === "completed" ? captured.value.source : mutationSource(definition, parameters);
  const observedFiles: ScriptMutationOutcome["files"] = captured.completions.map((completion) => ({
    source: completion.resourceSource,
    before: completion.existed ? completion.before.content : null,
    after: completion.after.content,
    action: definition.name === "write" ? "overwritten" : "edited",
    changes: [],
    formatting: { status: "not-reported" },
  }));
  const failed = (
    code: string,
    message: string,
    effect: ScriptMutationOutcome["effect"],
    completed: readonly string[] = [],
  ): ScriptMutationOutcome => ({
    operation: definition.name,
    ok: false,
    effect: effect === "unknown" ? "unknown" : observedFiles.length > 0 ? "applied" : effect,
    completed: [...new Set([...completed, ...observedFiles.map((file) => file.source)])],
    files: observedFiles,
    errors: [{ source, code, message }],
  });
  if (captured.kind === "failed")
    return failed("EXECUTION_FAILED", errorMessage(captured.error), "unknown");
  const { pipeline } = captured.value;
  if (pipeline.kind === "failed")
    return {
      ...failed(pipeline.failure.code, pipeline.failure.message, "not-applied"),
      recoveries: await scriptAnchorRecoveries(pipeline.failure.cause),
    };
  const outcome = pipeline.state.result;
  if (!isResourcesEditOutcome(outcome))
    return failed("INVALID_RESULT", "Invalid mutation outcome", "unknown");
  if (outcome.kind === "failed")
    return {
      ...failed(
        outcome.failure.code,
        outcome.failure.message,
        outcome.completed.length > 0 ? "unknown" : "not-applied",
        outcome.completed,
      ),
      recoveries: await scriptAnchorRecoveries(outcome.failure.cause),
    };
  const mutation = outcome.result as ExecutedTextMutation;
  const files = outcome.resources.flatMap((resource) => {
    const edit = mutation.edits.get(resource.source);
    if (edit === undefined) return [];
    const presentation = withPipelineStatuses(
      buildSuccessfulTextMutationResult(resource, resource.source, edit),
      pipeline.state.metadata,
    );
    onPresentation?.(resource.after.source, presentation);
    const data = presentation.data;
    return [
      {
        source: resource.after.source,
        before:
          captured.completions.find(
            (completion) => completion.resourceSource === resource.after.source,
          )?.existed === false
            ? null
            : resource.before.content,
        after: resource.after.content,
        action: edit.action,
        changes: data.rawChanges ?? [],
        formatting: data.formatting ?? { status: "not-reported" as const },
      },
    ];
  });
  return {
    operation: definition.name,
    ok: true,
    effect: files.length > 0 ? "applied" : "not-applied",
    files,
    completed: files.map((file) => file.source),
    ...(pipeline.state.metadata !== undefined && { metadata: pipeline.state.metadata }),
    errors: [],
  };
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
      "not-applied",
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

    const completed =
      outcome.completed.length === 0 ? "" : ` Completed writes: ${outcome.completed.join(", ")}.`;
    const effect = outcome.completed.length === 0 ? "not-applied" : "applied";
    const message = `${outcome.failure.message.replace(/[.!?]+$/u, "")}.${completed}`;
    return failureToolResult(source, outcome.failure.code, message, effect);
  }

  const mutation = outcome.result as ExecutedTextMutation;
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
            [{ operation, changes: edit.changes.length }],
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

async function scriptAnchorRecoveries(
  cause: unknown,
): Promise<NonNullable<ScriptMutationOutcome["recoveries"]>> {
  if (cause instanceof TextMutationAnchorAggregateError)
    return (await Promise.all(cause.failures.map(scriptAnchorRecoveries))).flat();
  if (!(cause instanceof TextMutationAnchorResolutionError)) return [];
  const recovery = await resolveAnchorRecovery(cause);
  return [
    {
      path: cause.source,
      field: cause.field,
      anchor: cause.anchor,
      status: recovery?.kind ?? "unavailable",
      candidates: recovery?.kind === "candidates" ? recovery.candidates : [],
      total: recovery?.kind === "candidates" ? recovery.total : 0,
    },
  ];
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
    for (const item of recovered) {
      if (item === undefined) {
        continue;
      }
      results.push(...(item.details.results ?? []));
      anchorRecoveries.push(...(item.details.anchorRecoveries ?? []));
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
      details: { results, anchorRecoveries },
    };
  }
  if (!(failure.cause instanceof TextMutationAnchorResolutionError)) {
    return undefined;
  }

  const contextual = failure.cause;
  const resolution = contextual.resolution;
  const recovery = await resolveAnchorRecovery(contextual);
  if (recovery?.kind === "timed-out") {
    return failureToolResult(
      contextual.source,
      failure.code,
      `${failure.message}; recovery timed out`,
      "not-applied",
    );
  }

  const windows =
    recovery?.kind === "candidates"
      ? recoveryWindows(
          recovery.candidates.map(({ range }) => range),
          core.recoveryContextLines(),
        )
      : resolution.rejection?.contextRange === undefined
        ? []
        : [resolution.rejection.contextRange];
  if (windows.length === 0) {
    return undefined;
  }

  const reads = await Promise.all(
    windows.map((range) =>
      readTextAnchorRecovery(
        core,
        { path: contextual.source, ...range },
        {
          cwd: context.cwd,
          ...(context.signal !== undefined && { signal: context.signal }),
        },
      ),
    ),
  );
  const recoveryTexts: string[] = [];
  for (const read of reads) {
    if (read === undefined || read.isError === true) {
      return undefined;
    }
    recoveryTexts.push(
      ...read.content.filter((block) => block.type === "text").map((block) => block.text),
    );
  }

  const result = new FileMutationResult({
    ok: false,
    path: contextual.source,
    errors: [{ path: contextual.source, code: failure.code, reason: failure.message }],
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
          ? "is invalid"
          : "could not be resolved";
  const guidance =
    code === "ambiguous"
      ? "Use a unique text span or one of the candidate anchors below."
      : "If the intended text is represented below, use its candidate anchor. Otherwise, reread the relevant section and choose a current anchor.";
  const context = recoveryContext.length === 0 ? "" : `\n\n${recoveryContext}`;
  return `[SYSTEM] ${failure.toolName} blocked: ${failure.field} anchor "${failure.anchor}" ${state}. ${guidance} (${reason})${context}`;
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
  return effect === "not-applied"
    ? ((await anchorFailureToolResult(core, failure, context)) ??
        failureToolResult(failure.source, failure.code, failure.message, effect))
    : failureToolResult(failure.source, failure.code, failure.message, effect);
}

function failureToolResult(
  source: string,
  code: string,
  reason: string,
  effect: "not-applied" | "applied" | "unknown",
): { content: [{ type: "text"; text: string }]; details: FileMutationBatchResult } {
  const result = new FileMutationResult({
    ok: false,
    path: source,
    errors: [{ path: source, code, reason }],
  });

  return {
    content: [new FileMutationAgentResult(result).toTextContent()],
    details: { results: [result], effect } as FileMutationBatchResult,
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
