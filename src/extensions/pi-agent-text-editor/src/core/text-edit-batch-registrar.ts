import { FileMutationAgentResult } from "#src/core/mutation-result/file-mutation-agent-result.js";
import { applyTextChanges, type TextChange, TextChangeDocument } from "#src/core/text-change-engine.js";
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
import { contextualizeTextMutationAnchorError } from "#src/core/text-mutation-anchor-error.js";
import {
    buildFailedTextMutationResult,
    buildSuccessfulTextMutationResult,
    mutationSources,
} from "#src/core/text-mutation.js";
import { registerBlockedToolCallSink } from "#src/core/tool-call-interceptor/coordinator.js";

import type { TextEditIntent } from "#src/api/edit-completion.js";
import type { FileMutationResult } from "#src/api/mutation-result.js";
import type { AnyTextMutationToolRegistration, TextMutation } from "#src/api/mutation-tool.js";
import type { BatchExecutionReporter } from "#src/core/text-edit-batch-execution.js";
import type { TextEditorCore, TextResourceEditFailure, TextResourcesEditOutcome } from "#src/core/text-editor-core.js";
import type {
    AgentToolResult,
    AgentToolUpdateCallback,
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface TextBatchState
{
    readonly source: string;
    readonly registration: AnyTextMutationToolRegistration;
}

interface PlannedTextBatch
{
    readonly mutations: readonly { readonly callId: string; readonly mutation: TextMutation; }[];
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
): void
{
    renderArgumentSinks.set(core, sink);
}

export function registerTextEditBatching(pi: ExtensionAPI, core: TextEditorCore): void
{
    const sourceTools: string[] = [];
    const registrations = new Map<string, AnyTextMutationToolRegistration>();
    const renderArguments = (toolCallId: string, patch: Readonly<Record<string, unknown>>): void =>
        renderArgumentSinks.get(core)?.(toolCallId, patch);
    const definition: ToolBatchDefinition<TextBatchState> = {
        sourceTools,
        syntheticTool: "__pi_agent_text_editor_batch",
        resolveCall(call, inherited)
        {
            const registration = registrations.get(call.name);

            if (registration === undefined)
            {
                return;
            }

            const explicit = call.arguments[registration.source.field];
            const inheritedSource = !(typeof explicit === "string" && explicit.length > 0)
                    && registration.source.inherited
                ? inherited?.source
                : undefined;
            const source = typeof explicit === "string" && explicit.length > 0 ? explicit : inheritedSource;

            return source === undefined
                ? undefined
                : {
                    call,
                    state: { source, registration },
                    ...(inheritedSource === undefined
                        ? {}
                        : { renderArgumentPatch: { [registration.source.field]: inheritedSource } }),
                };
        },
        buildArguments(calls)
        {
            const edits: TextBatchEntry[] = calls.map(({ call, state }) => ({
                ...call.arguments,
                [state.registration.source.field]: state.source,
                callId: call.id,
                op: state.registration.name,
                path: state.source,
            }));
            return { edits } satisfies TextBatchParams;
        },
        execute: (_toolCallId, params, signal, onUpdate, context, reporter) =>
            executeRegisteredTextBatch(
                core,
                registrations,
                params as unknown as TextBatchParams,
                signal,
                onUpdate,
                context,
                reporter,
            ),
        splitResult: splitTextBatchResult,
        onRenderArguments: renderArguments,
    };

    core.onMutationTool((registration) =>
    {
        registrations.set(registration.name, registration);
        sourceTools.push(registration.name);
    });
    registerBlockedToolCallSink(pi, registerBlockedToolCall);
    registerToolBatch(pi, definition);
}

export async function executeRegisteredTextBatch(
    core: TextEditorCore,
    registrations: ReadonlyMap<string, AnyTextMutationToolRegistration>,
    params: TextBatchParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TextBatchDetails> | undefined,
    context: ExtensionContext,
    reporter: BatchExecutionReporter,
): Promise<AgentToolResult<TextBatchDetails>>
{
    const prepared = params.edits.map((entry) =>
    {
        const registration = registrations.get(entry.op);

        if (registration === undefined)
        {
            throw new Error(`Unknown text mutation tool: ${entry.op}.`);
        }

        const { callId, op: _op, ...input } = entry;
        return { callId, input, registration, sources: mutationSources(registration, input) };
    });
    const intents = new Set(prepared.map(({ registration }) => registration.intent ?? "edit"));
    const intent: TextEditIntent = intents.size > 1 ? "mixed" : intents.values().next().value ?? "edit";
    const requests = new Map<string, { source: string; read: true; allowReadFailure?: true; }>();

    for (const item of prepared)
    {
        for (const source of item.sources.values())
        {
            const current = requests.get(source);
            const allowReadFailure = item.registration.name === "write"
                && source === item.sources.get(item.registration.source.field);
            requests.set(source, {
                source,
                read: true,
                ...(current?.allowReadFailure === true || allowReadFailure ? { allowReadFailure: true } : {}),
            });
        }

        reporter.start(item.callId);
    }

    let outcome: TextResourcesEditOutcome<PlannedTextBatch>;

    try
    {
        outcome = await core.editTexts(
            [...requests.values()],
            { cwd: context.cwd, intent, ...(signal === undefined ? {} : { signal }) },
            async (texts, resolveAnchor) =>
            {
                const mutations: { readonly callId: string; readonly mutation: TextMutation; }[] = [];
                const failures: PlannedTextBatch["failures"][number][] = [];
                const changes = new Map<string, TextChange[]>();

                for (const item of prepared)
                {
                    const sourceFor = (field: string): string =>
                    {
                        const source = item.sources.get(field);

                        if (source === undefined)
                        {
                            throw new Error(`Unknown mutation source field ${field}`);
                        }

                        return source;
                    };
                    const documentFor = (source: string): TextChangeDocument =>
                    {
                        const text = texts.get(source);

                        if (text === undefined)
                        {
                            throw new Error(`Unknown mutation resource ${source}`);
                        }

                        return new TextChangeDocument(text);
                    };
                    const resolveAnchors = async (field: string) =>
                    {
                        const descriptor = (item.registration.anchors ?? []).find((anchor) => anchor.field === field);
                        const value = item.input[field];
                        const source = descriptor === undefined ? undefined : item.sources.get(descriptor.sourceField);

                        if (descriptor === undefined || typeof value !== "string" || source === undefined)
                        {
                            throw new Error(`Unable to resolve mutation anchor ${field}`);
                        }

                        try
                        {
                            return new Map([[source, await resolveAnchor(source, value, descriptor.kinds)]]);
                        }
                        catch (error)
                        {
                            throw contextualizeTextMutationAnchorError(
                                error,
                                item.registration.name,
                                field,
                                source,
                                value,
                            );
                        }
                    };

                    try
                    {
                        const mutation = await item.registration.mutate({
                            cwd: context.cwd,
                            ...(signal === undefined ? {} : { signal }),
                            sourceDocument: documentFor(sourceFor(item.registration.source.field)),
                            sourceFor,
                            documentFor,
                            targetDocument: (field) => documentFor(sourceFor(field)),
                            resolveAnchors,
                            async resolveAnchor(field)
                            {
                                const resolved = await resolveAnchors(field);
                                return resolved.values().next().value!;
                            },
                        }, item.input);
                        mutations.push({ callId: item.callId, mutation });

                        for (const [source, edit] of mutation.edits)
                        {
                            changes.set(source, [...(changes.get(source) ?? []), ...edit.changes]);
                        }
                    }
                    catch (error)
                    {
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
    }
    catch (error)
    {
        return failTextBatch(core, prepared.map(({ callId }) => callId), error, context, reporter);
    }

    if (outcome.kind === "failed")
    {
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

    for (const entry of outcome.result.mutations)
    {
        try
        {
            await entry.mutation.afterWrite?.();
            completedMutations.push(entry);
        }
        catch (error)
        {
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

    for (const { callId, mutation } of completedMutations)
    {
        const callResults = [...mutation.edits].flatMap(([source, edit]) =>
        {
            const resource = outcome.resources.find((candidate) => candidate.source === source);

            if (resource === undefined)
            {
                return [];
            }

            const ownAfter = applyTextChanges(resource.before.content, edit.changes).content;
            return [buildSuccessfulTextMutationResult(resource, source, edit, ownAfter)];
        });
        const callResult = textBatchResult(callResults, callResults.map(() => callId));
        reporter.complete(callId, callResult);
        results.push(...callResults);
        callIdsByResult.push(...callResults.map(() => callId));
    }

    for (const failure of failures)
    {
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
        reporter.fail(failure.callId, { error: failure.error, effect: failure.effect, result: failedResult });
        results.push(...failureResults);
        callIdsByResult.push(...failureResults.map(() => failure.callId));
    }

    onUpdate?.({
        content: [{ type: "text", text: "post-edit progress" }],
        details: { results: [...results], callIdsByResult: [...callIdsByResult] },
    });
    return textBatchResult(results, callIdsByResult);
}

async function failTextBatch(
    core: TextEditorCore,
    callIds: readonly string[],
    error: unknown,
    context: ExtensionContext,
    reporter: BatchExecutionReporter,
): Promise<AgentToolResult<TextBatchDetails>>
{
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

    for (const callId of callIds)
    {
        reporter.fail(callId, {
            error: cause,
            effect: "not-applied",
            ...(callId === failedCallId ? { result: failedResult } : {}),
        });
    }

    const results = failedResult.details.results ?? [];
    return textBatchResult(results, results.map(() => failedCallId ?? ""));
}

function isTextResourceEditFailure(value: unknown): value is TextResourceEditFailure
{
    return typeof value === "object"
        && value !== null
        && typeof (value as Partial<TextResourceEditFailure>).code === "string"
        && typeof (value as Partial<TextResourceEditFailure>).source === "string"
        && typeof (value as Partial<TextResourceEditFailure>).message === "string";
}

function errorMessage(error: unknown): string
{
    return error instanceof Error ? error.message : String(error);
}

function textBatchResult(
    results: FileMutationResult[],
    callIdsByResult: string[],
): AgentToolResult<TextBatchDetails>
{
    return {
        content: [new FileMutationAgentResult(results).toTextContent()],
        details: { results, callIdsByResult },
    };
}

export function executeTextToolWithBatch<Result>(
    toolCallId: string,
    execute: () => Promise<AgentToolResult<Result>>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<Result> | undefined,
    context: ExtensionContext,
): Promise<AgentToolResult<Result>>
{
    return executeWithBatchCoordinator(toolCallId, execute, signal, onUpdate, context);
}
