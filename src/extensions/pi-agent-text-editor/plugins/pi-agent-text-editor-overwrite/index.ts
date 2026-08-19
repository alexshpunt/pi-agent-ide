import path from "node:path";

import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
    TEXT_EDITOR_API_VERSION,
    TEXT_EDITOR_PROTOCOL,
    type TextEditorPlugin,
    type TextEditorPluginApi,
} from "pi-agent-text-editor/api/plugin-protocol";
import {
    type InterceptResult,
    registerToolCallInterceptor,
    type ToolCallInterceptorHandler,
} from "pi-agent-text-editor/api/tool-call-interceptor";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
    TextMutationGuardRegistration,
    TextMutationGuardRejection,
    TextMutationPlan,
} from "pi-agent-text-editor/api/mutation-guard";
import type { TextMutationPreviewResource } from "pi-agent-text-editor/api/mutation-preview";
import type { TextMutationToolRegistration } from "pi-agent-text-editor/api/mutation-tool";

interface OverwriteCandidate
{
    readonly source: string;
    readonly afterContent: string;
}

type FinalOverwriteDecision =
    | { readonly kind: "accepted"; }
    | { readonly kind: "rejected"; readonly rejection: TextMutationGuardRejection; };
type OverwriteDecision = FinalOverwriteDecision | { readonly kind: "deferred"; };

class OverwriteAttempts
{
    private readonly pending = new Set<string>();
    private readonly pendingBySource = new Map<string, Set<string>>();
    private readonly approvedForExecution = new Set<string>();
    private readonly pendingEarly = new Set<string>();
    private readonly approvedEarlyForExecution = new Set<string>();

    inspectEarly(candidates: readonly OverwriteCandidate[]): OverwriteDecision
    {
        const key = sourceAttemptKey(candidates);

        if (this.pendingEarly.delete(key))
        {
            this.approvedEarlyForExecution.add(key);
            return { kind: "accepted" };
        }

        if ((this.pendingBySource.get(key)?.size ?? 0) > 0)
        {
            return { kind: "deferred" };
        }

        this.pendingEarly.add(key);
        return rejected();
    }

    inspectStream(candidates: readonly OverwriteCandidate[]): FinalOverwriteDecision
    {
        const earlyKey = sourceAttemptKey(candidates);

        if (this.pendingEarly.delete(earlyKey))
        {
            this.approvedEarlyForExecution.add(earlyKey);
            return { kind: "accepted" };
        }

        const key = attemptKey(candidates);

        if (this.pending.delete(key))
        {
            this.forgetPending(earlyKey, key);
            this.approvedForExecution.add(key);
            return { kind: "accepted" };
        }

        this.rememberPending(earlyKey, key);
        return rejected();
    }

    inspectExecution(candidates: readonly OverwriteCandidate[]): FinalOverwriteDecision
    {
        const earlyKey = sourceAttemptKey(candidates);

        if (this.approvedEarlyForExecution.delete(earlyKey))
        {
            return { kind: "accepted" };
        }

        const key = attemptKey(candidates);

        if (this.approvedForExecution.delete(key))
        {
            return { kind: "accepted" };
        }

        if (this.pending.delete(key))
        {
            this.forgetPending(earlyKey, key);
            return { kind: "accepted" };
        }

        this.rememberPending(earlyKey, key);
        return rejected();
    }

    private rememberPending(sourceKey: string, key: string): void
    {
        this.pending.add(key);
        const keys = this.pendingBySource.get(sourceKey) ?? new Set<string>();
        keys.add(key);
        this.pendingBySource.set(sourceKey, keys);
    }

    private forgetPending(sourceKey: string, key: string): void
    {
        const keys = this.pendingBySource.get(sourceKey);

        if (keys === undefined)
        {
            return;
        }

        keys.delete(key);

        if (keys.size === 0)
        {
            this.pendingBySource.delete(sourceKey);
        }
    }
}

export default function registerTextEditorOverwriteGuard(pi: ExtensionAPI): void | Promise<void>
{
    const attempts = new OverwriteAttempts();
    const plugin = {
        protocol: TEXT_EDITOR_PROTOCOL,
        apiVersion: TEXT_EDITOR_API_VERSION,
        id: "text-editor-overwrite",
        setup(api)
        {
            api.addMutationGuard(createGuard(attempts));
            const dynamic = createStreamingGuard(pi, api, attempts);
            registerToolCallInterceptor(pi, dynamic.handler);
            api.onMutationTool(dynamic.add);
        },
    } satisfies TextEditorPlugin;

    return connectTextEditorPlugin(pi, plugin);
}

export function createOverwriteGuard(): TextMutationGuardRegistration
{
    return createGuard(new OverwriteAttempts());
}

function createGuard(attempts: OverwriteAttempts): TextMutationGuardRegistration
{
    return {
        id: "overwrite",
        guard(plan, context)
        {
            if (context.intent === "restore")
            {
                return { kind: "accepted" };
            }

            const candidates = planCandidates(plan, context.cwd);
            return candidates.length === 0 ? { kind: "accepted" } : attempts.inspectExecution(candidates);
        },
    };
}

function createStreamingGuard(
    pi: ExtensionAPI,
    api: TextEditorPluginApi,
    attempts: OverwriteAttempts,
): {
    readonly handler: ToolCallInterceptorHandler;
    readonly add: (registration: TextMutationToolRegistration) => void;
}
{
    const registrations = new Map<string, TextMutationToolRegistration>();
    const acceptedContentIndices = new Set<number>();
    const toolNames: string[] = [];
    const handler: ToolCallInterceptorHandler = {
        name: "text-editor-overwrite-inspection",
        blockExecution: true,
        toolNames,
        async intercept(context)
        {
            if (context.contentIndex !== undefined && acceptedContentIndices.has(context.contentIndex))
            {
                return;
            }

            const registration = registrations.get(context.toolCall.name);

            if (registration === undefined)
            {
                return;
            }

            const isEarly = context.partialArgs !== undefined;
            const input = isEarly
                ? preparePreviewArguments(registration, context.partialArgs!)
                : context.args;
            const preview = await api.previewMutation({
                tool: context.toolCall.name,
                input,
                cwd: context.cwd,
                ...(context.signal === undefined ? {} : { signal: context.signal }),
            });

            if (preview.kind === "failed")
            {
                return;
            }

            const candidates = previewCandidates(preview.resources, context.toolCall.name, isEarly, context.cwd);

            if (candidates.length === 0)
            {
                return;
            }

            const decision = isEarly
                ? attempts.inspectEarly(candidates)
                : attempts.inspectStream(candidates);

            if (decision.kind === "rejected")
            {
                return interceptResult(decision.rejection);
            }

            if (decision.kind === "accepted" && isEarly && context.contentIndex !== undefined)
            {
                acceptedContentIndices.add(context.contentIndex);
            }

            return;
        },
        onContentEnd(contentIndex)
        {
            acceptedContentIndices.delete(contentIndex);
        },
        onAbort(contentIndex)
        {
            acceptedContentIndices.delete(contentIndex);
        },
        onAgentEnd()
        {
            acceptedContentIndices.clear();
        },
    };

    return {
        handler,
        add(registration): void
        {
            if (registration.intent === "restore")
            {
                return;
            }

            registrations.set(registration.name, registration);
            toolNames.push(registration.name);
            registerToolCallInterceptor(pi, handler);
        },
    };
}

function planCandidates(plan: TextMutationPlan, cwd: string): OverwriteCandidate[]
{
    return plan.resources
        .filter((resource) =>
            resource.existed
            && resource.after.content !== resource.before.content
            && resource.changes.some(({ fromBefore, toBefore }) =>
                fromBefore === 0 && toBefore === resource.before.content.length
            )
        )
        .map((resource) => ({ source: canonicalSource(resource.source, cwd), afterContent: resource.after.content }));
}

function preparePreviewArguments(
    registration: TextMutationToolRegistration,
    args: Readonly<Record<string, unknown>>,
): Record<string, unknown>
{
    const prepared = { ...args };
    const schema = registration.parameters as {
        readonly required?: unknown;
        readonly properties?: Readonly<Record<string, { readonly type?: unknown; }>>;
    };

    if (!Array.isArray(schema.required))
    {
        return prepared;
    }

    for (const field of schema.required)
    {
        if (typeof field === "string" && !(field in prepared) && schema.properties?.[field]?.type === "string")
        {
            prepared[field] = "";
        }
    }

    return prepared;
}

function previewCandidates(
    resources: readonly TextMutationPreviewResource[],
    toolName: string,
    early: boolean,
    cwd: string,
): OverwriteCandidate[]
{
    const writePathIsEnough = early && toolName === "write";
    return resources
        .filter((resource) =>
            resource.existed === true
            && (writePathIsEnough || (
                resource.afterContent !== resource.beforeContent
                && resource.beforeRanges?.some(({ from, to }) => from === 0 && to === resource.beforeContent.length)
                    === true
            ))
        )
        .map((resource) => ({ source: canonicalSource(resource.path, cwd), afterContent: resource.afterContent }));
}

function canonicalSource(source: string, cwd: string): string
{
    return /^[A-Za-z][A-Za-z\d+.-]*:/u.test(source) || path.isAbsolute(source)
        ? source
        : path.resolve(cwd, source);
}

function attemptKey(resources: readonly OverwriteCandidate[]): string
{
    return [...resources]
        .sort((left, right) => left.source.localeCompare(right.source))
        .map(({ source, afterContent }) => `${source}\u0000${afterContent}`)
        .join("\u0001");
}

function sourceAttemptKey(resources: readonly OverwriteCandidate[]): string
{
    return [...resources]
        .map(({ source }) => source)
        .sort((left, right) => left.localeCompare(right))
        .join("\u0001");
}

function rejected(): FinalOverwriteDecision
{
    const message = "The file already exists — a full rewrite may be unnecessary. "
        + "Overwriting is error-prone, token-cost ineffective and simply stupid. "
        + "Think again and prefer precise text editing operations. "
        + "If the task genuinely requires overwriting this file, state why and repeat the same operation.";

    return {
        kind: "rejected",
        rejection: {
            code: "MUTATION_REJECTED",
            reason: message,
            message,
            annotation: { kind: "overwrite-blocked" },
            effect: "not-applied",
        },
    };
}

function interceptResult(rejection: TextMutationGuardRejection): InterceptResult
{
    return {
        annotation: { kind: "custom", label: "Overwrite Blocked", color: "warning" },
        message: {
            customType: "text-editor-overwrite-block",
            content: `Reason: ${rejection.reason}`,
            display: false,
            details: rejection,
        },
    };
}
