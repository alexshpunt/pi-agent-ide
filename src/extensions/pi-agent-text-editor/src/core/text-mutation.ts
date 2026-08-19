import path from "node:path";

import {
    type AgentToolResult,
    defineTool,
    type ExtensionContext,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { type FileMutationBatchResult, FileMutationResult } from "#src/api/mutation-result.js";
import {
    mutationSource,
    type TextMutation,
    type TextMutationContext,
    type TextMutationEdit,
    type TextMutationToolRegistration,
} from "#src/api/mutation-tool.js";
import { isTextMutationResultContributionData } from "#src/api/post-edit.js";
import { formatStaleAnchorMessage, type StaleAnchorMessageDetails } from "#src/api/stale-anchor-message.js";
import { createUnifiedDiff } from "#src/core/mutation-result/diff.js";
import { FileMutationAgentResult } from "#src/core/mutation-result/file-mutation-agent-result.js";
import { readTextAnchorRecovery } from "#src/core/text-anchor-recovery.js";
import { applyTextChanges, TextChangeDocument } from "#src/core/text-change-engine.js";
import { executeTextToolWithBatch } from "#src/core/text-edit-batch-registrar.js";
import {
    contextualizeTextMutationAnchorError,
    TextMutationAnchorResolutionError,
} from "#src/core/text-mutation-anchor-error.js";
import {
    type ToolCallInterceptionRenderStore,
    withToolCallInterceptionRendering,
} from "#src/core/tool-call-interceptor/rendering.js";
import { appendSchemaFieldOrder } from "#src/core/tool-description.js";

import type { TextEditExecutionOutcome } from "#src/api/edit-pipeline.js";
import type { TextMutationPreviewOutcome, TextMutationPreviewRequest } from "#src/api/mutation-preview.js";
import type {
    ResolveResourceTextAnchor,
    TextEditorCore,
    TextResourceEditFailure,
    TextResourceEditOutcome,
    TextResourcesEditOutcome,
} from "#src/core/text-editor-core.js";
import type { TextAnchor } from "pi-agent-text";
import type { Static, TSchema } from "typebox";

export function createTextTool<TParams extends TSchema>(
    core: TextEditorCore,
    definition: TextMutationToolRegistration<TParams>,
    annotations: ToolCallInterceptionRenderStore,
    pluginPromptGuideline: () => string | undefined,
    getLastResolvedSource: () => string | undefined,
): ToolDefinition<TParams, FileMutationBatchResult>
{
    const renderer = core.getToolRenderer(definition.name);

    const tool = withToolCallInterceptionRendering<TParams, FileMutationBatchResult, unknown>(
        defineTool<TParams, FileMutationBatchResult, unknown>({
            name: definition.name,
            label: definition.name,
            description: appendSchemaFieldOrder(definition.description, definition.parameters),
            parameters: definition.parameters,
            prepareArguments: (args) =>
                prepareGuardedArguments(
                    definition.parameters,
                    args,
                    definition.source.inherited ? definition.source.field : undefined,
                    getLastResolvedSource(),
                ),
            ...(renderer?.renderShell === undefined ? {} : { renderShell: renderer.renderShell }),
            ...(renderer?.renderCall === undefined ? {} : { renderCall: renderer.renderCall }),
            ...(renderer?.renderResult === undefined ? {} : { renderResult: renderer.renderResult }),
            async execute(toolCallId, params, signal, onUpdate, context)
            {
                const directExecute = () =>
                    executeTextMutation(core, definition, params as unknown as Static<TParams>, signal, context);
                return executeTextToolWithBatch(toolCallId, directExecute, signal, onUpdate, context);
            },
        }),
        annotations,
    );
    Object.defineProperty(tool, "promptGuidelines", {
        enumerable: true,
        get(): string[] | undefined
        {
            const guideline = pluginPromptGuideline();
            return guideline === undefined ? undefined : [guideline];
        },
    });
    return tool;
}

function prepareGuardedArguments<TParams extends TSchema>(
    schema: TParams,
    args: unknown,
    sourceField: string | undefined,
    lastResolvedSource: string | undefined,
): ReturnType<NonNullable<ToolDefinition<TParams, FileMutationBatchResult>["prepareArguments"]>>
{
    const prepared = args !== null && typeof args === "object" && !Array.isArray(args)
        ? { ...(args as Record<string, unknown>) }
        : {};
    const required = (schema as { required?: unknown; }).required;
    const properties = (schema as { properties?: Record<string, { type?: unknown; }>; }).properties;

    if (sourceField !== undefined && !(sourceField in prepared) && lastResolvedSource !== undefined)
    {
        prepared[sourceField] = lastResolvedSource;
    }

    if (Array.isArray(required))
    {
        for (const field of required)
        {
            if (typeof field === "string" && !(field in prepared) && properties?.[field]?.type === "string")
            {
                prepared[field] = "";
            }
        }
    }

    return prepared as ReturnType<NonNullable<ToolDefinition<TParams, FileMutationBatchResult>["prepareArguments"]>>;
}

interface ResolvedMutationSources
{
    readonly fields: ReadonlyMap<string, string>;
    readonly anchors: ReadonlyMap<string, readonly string[]>;
    readonly resources: readonly string[];
}

async function resolveMutationSources(
    core: TextEditorCore,
    definition: TextMutationToolRegistration,
    input: Readonly<Record<string, unknown>>,
    context: { readonly cwd: string; readonly signal?: AbortSignal; },
): Promise<ResolvedMutationSources>
{
    const expandedByAnchor = new Map<string, readonly string[]>();
    const expandedBySourceField = new Map<string, readonly string[]>();

    for (const descriptor of definition.anchors ?? [])
    {
        const value = input[descriptor.field];

        if (typeof value !== "string" || value.length === 0)
        {
            continue;
        }

        let expanded: readonly string[] | undefined;

        try
        {
            expanded = await core.resolveTextAnchorResources(value, descriptor.kinds, context);
        }
        catch (error)
        {
            const source = input[descriptor.sourceField];
            throw contextualizeTextMutationAnchorError(
                error,
                definition.name,
                descriptor.field,
                typeof source === "string" ? source : "",
                value,
            );
        }

        if (expanded === undefined)
        {
            continue;
        }

        const previous = expandedBySourceField.get(descriptor.sourceField);

        if (previous !== undefined && !sameResources(previous, expanded, context.cwd))
        {
            throw new Error(`Mutation anchors for ${descriptor.sourceField} refer to different resources.`);
        }

        expandedByAnchor.set(descriptor.field, expanded);
        expandedBySourceField.set(descriptor.sourceField, expanded);
    }

    const fields = new Map<string, string>();
    const sourceDescriptors = [definition.source, ...(definition.source.targets ?? [])];

    for (const descriptor of sourceDescriptors)
    {
        const explicit = input[descriptor.field];
        const explicitSource = typeof explicit === "string" && explicit.length > 0 ? explicit : undefined;
        const fallback = "fallbackTo" in descriptor ? fields.get(descriptor.fallbackTo) : undefined;
        const expanded = expandedBySourceField.get(descriptor.field);

        if (expanded !== undefined)
        {
            if (explicitSource === undefined)
            {
                fields.set(descriptor.field, expanded[0]!);
            }
            else
            {
                if (expanded.length !== 1)
                {
                    throw new Error(
                        `${descriptor.field} must be omitted when a search anchor selects multiple resources.`,
                    );
                }

                if (!sameResource(explicitSource, expanded[0]!, context.cwd))
                {
                    throw new Error(`Anchor does not belong to ${explicitSource}.`);
                }

                fields.set(descriptor.field, explicitSource);
            }

            continue;
        }

        const source = explicitSource ?? fallback;

        if (source === undefined)
        {
            throw new Error(`${descriptor.field} is required`);
        }

        fields.set(descriptor.field, source);
    }

    const anchors = new Map<string, readonly string[]>();

    for (const descriptor of definition.anchors ?? [])
    {
        const expanded = expandedByAnchor.get(descriptor.field);
        const source = fields.get(descriptor.sourceField);

        if (expanded !== undefined)
        {
            anchors.set(
                descriptor.field,
                source !== undefined && expanded.length === 1 ? [source] : expanded,
            );
        }
        else if (source !== undefined)
        {
            anchors.set(descriptor.field, [source]);
        }
    }

    return {
        fields,
        anchors,
        resources: [...new Set([...fields.values(), ...[...anchors.values()].flat()])],
    };
}

function createMutationContext(
    definition: TextMutationToolRegistration,
    input: Readonly<Record<string, unknown>>,
    invocation: { readonly cwd: string; readonly signal?: AbortSignal; },
    sources: ResolvedMutationSources,
    texts: ReadonlyMap<string, string>,
    resolveResourceAnchor: ResolveResourceTextAnchor,
): TextMutationContext
{
    const documents = new Map([...texts].map(([source, text]) => [source, new TextChangeDocument(text)]));
    const anchorCache = new Map<string, Promise<ReadonlyMap<string, TextAnchor>>>();
    const sourceFor = (field: string): string =>
    {
        const source = sources.fields.get(field);

        if (source === undefined)
        {
            throw new Error(`Unknown mutation source field ${field}`);
        }

        return source;
    };
    const documentFor = (source: string): TextChangeDocument =>
    {
        const document = documents.get(source);

        if (document === undefined)
        {
            throw new Error(`Unknown mutation resource ${source}`);
        }

        return document;
    };
    const resolveAnchors = (field: string): Promise<ReadonlyMap<string, TextAnchor>> =>
    {
        const cached = anchorCache.get(field);

        if (cached !== undefined)
        {
            return cached;
        }

        const pending = (async () =>
        {
            const descriptor = (definition.anchors ?? []).find((anchor) => anchor.field === field);
            const value = input[field];
            const anchorSources = sources.anchors.get(field);

            if (descriptor === undefined || typeof value !== "string" || anchorSources === undefined)
            {
                throw new Error(`Mutation tool ${definition.name} tried to resolve undeclared anchor ${field}`);
            }

            return new Map(
                await Promise.all(anchorSources.map(async (source) =>
                {
                    try
                    {
                        return [source, await resolveResourceAnchor(source, value, descriptor.kinds)] as const;
                    }
                    catch (error)
                    {
                        throw contextualizeTextMutationAnchorError(error, definition.name, field, source, value);
                    }
                })),
            );
        })();
        anchorCache.set(field, pending);
        return pending;
    };

    return {
        cwd: invocation.cwd,
        ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
        sourceDocument: documentFor(sourceFor(definition.source.field)),
        sourceFor,
        documentFor,
        targetDocument(field): TextChangeDocument
        {
            if (!(definition.source.targets ?? []).some((target) => target.field === field))
            {
                throw new Error(`Mutation tool ${definition.name} tried to access undeclared target ${field}`);
            }

            return documentFor(sourceFor(field));
        },
        resolveAnchors,
        async resolveAnchor(field): Promise<TextAnchor>
        {
            const resolved = await resolveAnchors(field);

            if (resolved.size !== 1)
            {
                throw new Error(
                    `Anchor ${field} selects multiple resources; use an operation that supports a search set.`,
                );
            }

            return resolved.values().next().value!;
        },
    };
}

function sameResources(left: readonly string[], right: readonly string[], cwd: string): boolean
{
    const leftKeys = left.map((source) => resourceIdentity(source, cwd)).sort();
    const rightKeys = right.map((source) => resourceIdentity(source, cwd)).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
}

function sameResource(left: string, right: string, cwd: string): boolean
{
    return resourceIdentity(left, cwd) === resourceIdentity(right, cwd);
}

function resourceIdentity(source: string, cwd: string): string
{
    if (/^[a-z][a-z\d+.-]*:\/\//iu.test(source))
    {
        return source;
    }

    const fileSource = source.startsWith("@") ? source.slice(1) : source;
    return path.resolve(cwd, fileSource);
}

export async function previewTextMutation(
    core: TextEditorCore,
    request: TextMutationPreviewRequest,
): Promise<TextMutationPreviewOutcome>
{
    const definition = core.getMutationTools().find((candidate) => candidate.name === request.tool);

    if (definition === undefined)
    {
        return { kind: "failed", reason: `Unknown mutation tool ${request.tool}` };
    }

    try
    {
        const sources = await resolveMutationSources(core, definition, request.input, request);
        return await core.previewTexts(
            sources.resources.map((source) => ({
                source,
                read: true,
                ...(definition.name === "write" ? { allowReadFailure: true } : {}),
            })),
            { cwd: request.cwd, ...(request.signal === undefined ? {} : { signal: request.signal }) },
            async (texts, resolveAnchor) =>
            {
                const mutation = await definition.mutate(
                    createMutationContext(definition, request.input, request, sources, texts, resolveAnchor),
                    request.input,
                );

                return {
                    changes: new Map([...mutation.edits].map(([source, edit]) => [source, edit.changes])),
                    result: mutation,
                };
            },
        );
    }
    catch (error)
    {
        return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
}

export async function executeTextMutation<TParams extends TSchema>(
    core: TextEditorCore,
    definition: TextMutationToolRegistration<TParams>,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
): Promise<AgentToolResult<FileMutationBatchResult>>
{
    const source = mutationSource(definition, params);
    const pipeline = await core.executeEdit(
        definition.name,
        {
            cwd: context.cwd,
            input: params,
            ...(signal === undefined ? {} : { signal }),
        },
        async (state) =>
        {
            try
            {
                const sources = await resolveMutationSources(core, definition, state.input, state);
                const outcome = await core.editTexts(
                    sources.resources.map((resourceSource) => ({
                        source: resourceSource,
                        read: true,
                        ...(definition.name === "write" ? { allowReadFailure: true } : {}),
                    })),
                    {
                        cwd: state.cwd,
                        intent: definition.intent ?? "edit",
                        ...(state.signal === undefined ? {} : { signal: state.signal }),
                    },
                    async (texts, resolveAnchor) =>
                    {
                        const mutation = await definition.mutate(
                            createMutationContext(definition, state.input, state, sources, texts, resolveAnchor),
                            state.input,
                        );
                        return {
                            changes: new Map(
                                [...mutation.edits].map(([editSource, edit]) => [editSource, edit.changes]),
                            ),
                            result: mutation,
                        };
                    },
                );
                return await completeTextMutation(outcome, mutationSource(definition, state.input));
            }
            catch (error)
            {
                return failedResourceEdit(
                    mutationSource(definition, state.input),
                    "INVALID_REQUEST",
                    errorMessage(error),
                    error,
                );
            }
        },
    );

    return buildToolResult(core, pipeline, source, context);
}

export function mutationSources(
    definition: TextMutationToolRegistration,
    params: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, string>
{
    const sources = new Map<string, string>();
    const primary = params[definition.source.field];

    if (typeof primary !== "string" || primary.length === 0)
    {
        throw new Error(`${definition.source.field} is required`);
    }

    sources.set(definition.source.field, primary);

    for (const target of definition.source.targets ?? [])
    {
        const explicit = params[target.field];
        const fallback = sources.get(target.fallbackTo);
        const source = typeof explicit === "string" && explicit.length > 0 ? explicit : fallback;

        if (source === undefined)
        {
            throw new Error(`${target.field} is required`);
        }

        sources.set(target.field, source);
    }

    return sources;
}

type CompletedTextResource = Extract<TextResourceEditOutcome<unknown>, { readonly kind: "completed"; }>;

export function buildSuccessfulTextMutationResult(
    resource: CompletedTextResource,
    resultSource: string,
    edit: TextMutationEdit,
    diffAfterContent = resource.after.content,
): FileMutationResult
{
    const before = resource.before.content;
    const finalAfter = resource.after.content;
    const applied = applyTextChanges(before, edit.changes);
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
        ok: true,
        path: resultSource,
        diffs: [unified.diff],
        files: [{ path: resultSource, action: edit.action }],
        editCount: 1,
        addedLines: unified.stats.added,
        removedLines: unified.stats.removed,
        beforeContentMap: { [resultSource]: before },
        afterContent: finalAfter,
        rawChanges,
        afterDocument: resource.after,
    });
}

async function completeTextMutation(
    outcome: TextResourcesEditOutcome<TextMutation>,
    source: string,
): Promise<TextResourcesEditOutcome<TextMutation>>
{
    if (outcome.kind === "failed" || outcome.result.afterWrite === undefined)
    {
        return outcome;
    }

    try
    {
        await outcome.result.afterWrite();
        return outcome;
    }
    catch (error)
    {
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
): Promise<AgentToolResult<FileMutationBatchResult>>
{
    if (pipeline.kind === "failed")
    {
        return failureToolResult(source, pipeline.failure.code, pipeline.failure.message, "not-applied");
    }

    const outcome = pipeline.state.result;

    if (!isResourcesEditOutcome(outcome))
    {
        return failureToolResult(source, "INVALID_RESULT", "Text editor returned an invalid edit result.", "unknown");
    }

    if (outcome.kind === "failed")
    {
        const recovery = await anchorFailureToolResult(core, outcome.failure, context);

        if (recovery !== undefined)
        {
            return recovery;
        }

        const completed = outcome.completed.length === 0 ? "" : ` Completed writes: ${outcome.completed.join(", ")}.`;
        const effect = outcome.completed.length === 0 ? "not-applied" : "applied";
        const message = `${outcome.failure.message.replace(/[.!?]+$/u, "")}.${completed}`;
        return failureToolResult(source, outcome.failure.code, message, effect);
    }

    const mutation = outcome.result as TextMutation;
    const results = outcome.resources.flatMap((resource) =>
    {
        const resultSource = resource.source;
        const edit = mutation.edits.get(resultSource);
        return edit === undefined ? [] : [buildSuccessfulTextMutationResult(resource, resultSource, edit)];
    });

    return {
        content: [new FileMutationAgentResult(results).toTextContent()],
        details: { results },
    };
}

async function anchorFailureToolResult(
    core: TextEditorCore,
    failure: TextResourceEditFailure,
    context: ExtensionContext,
): Promise<AgentToolResult<FileMutationBatchResult> | undefined>
{
    if (!(failure.cause instanceof TextMutationAnchorResolutionError))
    {
        return undefined;
    }

    const contextual = failure.cause;
    const resolution = contextual.resolution;
    const range = resolution.rejection?.contextRange;

    if (range === undefined)
    {
        return undefined;
    }

    const read = await readTextAnchorRecovery(core, { path: contextual.source, ...range }, {
        cwd: context.cwd,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
    });

    if (read === undefined || read.isError === true)
    {
        return undefined;
    }

    const result = new FileMutationResult({
        ok: false,
        path: contextual.source,
        errors: [{ path: contextual.source, code: failure.code, reason: failure.message }],
    });
    const recoveryContext = read.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    const details: StaleAnchorMessageDetails = {
        guardId: "stale-anchor",
        effect: "not-applied",
        toolName: contextual.toolName,
        field: contextual.field,
        path: contextual.source,
        anchor: contextual.anchor,
        ...(recoveryContext.length === 0 ? {} : { context: recoveryContext }),
    };

    return {
        content: [{ type: "text", text: formatStaleAnchorMessage(details, resolution.message) }],
        details: {
            results: [result],
            effect: "not-applied",
            anchorRecovery: true,
        } as FileMutationBatchResult,
    };
}

export async function buildFailedTextMutationResult(
    core: TextEditorCore,
    failure: TextResourceEditFailure,
    context: ExtensionContext,
    effect: "applied" | "not-applied" | "unknown" = "not-applied",
): Promise<AgentToolResult<FileMutationBatchResult>>
{
    return effect === "not-applied"
        ? await anchorFailureToolResult(core, failure, context)
            ?? failureToolResult(failure.source, failure.code, failure.message, effect)
        : failureToolResult(failure.source, failure.code, failure.message, effect);
}

function failureToolResult(
    source: string,
    code: string,
    reason: string,
    effect: "not-applied" | "applied" | "unknown",
): { content: [{ type: "text"; text: string; }]; details: FileMutationBatchResult; }
{
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
): TextResourcesEditOutcome<never>
{
    return {
        kind: "failed",
        failure: { code, source, message, ...(cause === undefined ? {} : { cause }) },
        completed: [],
    };
}

function isResourcesEditOutcome(value: unknown): value is TextResourcesEditOutcome<unknown>
{
    return typeof value === "object"
        && value !== null
        && ((value as { kind?: unknown; }).kind === "completed" || (value as { kind?: unknown; }).kind === "failed");
}

function errorMessage(error: unknown): string
{
    return error instanceof Error ? error.message : String(error);
}
