import { Type } from "typebox";
import { Value } from "typebox/value";

import { isTextEditorCoreReady, TEXT_EDITOR_CORE_READY_EVENT, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.js";

import type { DiagnosticHint, SyntaxErrorSummary, Warning } from "#src/api/mutation-result.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TextDocument } from "pi-agent-text";

export const TEXT_EDITOR_POST_EDIT_REGISTER_EVENT = `${TEXT_EDITOR_PROTOCOL}/post-edit/register`;

export interface TextPostEditTransaction
{
    readonly source: string;
    readonly resourceSource: string;
    readonly resolvedBy: string;
    readonly cwd: string;
    readonly before: TextDocument;
    readonly requestedAfter: TextDocument;
    readonly signal?: AbortSignal;
}

export interface TextPostEditContribution
{
    readonly id: string;
    readonly data: unknown;
}

export interface TextMutationResultContributionData
{
    readonly hints: DiagnosticHint[];
    readonly scopeMarkers: Record<string, string[]>;
    readonly warnings: Warning[];
    readonly syntaxErrorSummary?: SyntaxErrorSummary;
}

export type TextPostEditHandler = (transaction: TextPostEditTransaction) => unknown;

export interface TextPostEditHandlerRegistration
{
    readonly id: string;
    readonly handler: TextPostEditHandler;
}

export interface TextPostEditHandlerRegistrationRequest
{
    readonly registration: TextPostEditHandlerRegistration;
    accept(dispose: () => void): void;
}

const functionSchema = Type.Function([], Type.Unknown());
const registrationSchema = Type.Object({
    id: Type.String({ minLength: 1 }),
    handler: functionSchema,
});
const registrationRequestSchema = Type.Object({
    registration: registrationSchema,
    accept: functionSchema,
});

export function isTextPostEditHandlerRegistration(
    value: unknown,
): value is TextPostEditHandlerRegistration
{
    return Value.Check(registrationSchema, value);
}

export function isTextPostEditHandlerRegistrationRequest(
    value: unknown,
): value is TextPostEditHandlerRegistrationRequest
{
    return Value.Check(registrationRequestSchema, value);
}

export function isTextMutationResultContributionData(value: unknown): value is TextMutationResultContributionData
{
    if (typeof value !== "object" || value === null)
    {
        return false;
    }

    const data = value as Record<PropertyKey, unknown>;

    return Array.isArray(data.hints)
        && typeof data.scopeMarkers === "object"
        && data.scopeMarkers !== null
        && Array.isArray(data.warnings);
}

export function connectTextEditorPostEditHandler(
    pi: ExtensionAPI,
    registration: TextPostEditHandlerRegistration,
): void
{
    if (!isTextPostEditHandlerRegistration(registration))
    {
        throw new TypeError("Invalid text editor post-edit handler registration");
    }

    let disposeHandler: (() => void) | undefined;
    const announce = (): boolean =>
    {
        const request = {
            registration,
            accept(dispose): void
            {
                if (disposeHandler !== undefined)
                {
                    throw new Error(`Post-edit handler ${registration.id} was accepted more than once`);
                }

                disposeHandler = dispose;
            },
        } satisfies TextPostEditHandlerRegistrationRequest;

        pi.events.emit(TEXT_EDITOR_POST_EDIT_REGISTER_EVENT, request);
        return disposeHandler !== undefined;
    };

    let unsubscribeReady = (): void =>
    {};
    unsubscribeReady = pi.events.on(TEXT_EDITOR_CORE_READY_EVENT, (ready) =>
    {
        if (!isTextEditorCoreReady(ready))
        {
            throw new Error("Invalid pi-agent-text-editor core readiness event");
        }

        if (!announce())
        {
            throw new Error("pi-agent-text-editor core announced readiness without accepting the post-edit handler");
        }

        unsubscribeReady();
    });

    pi.on("session_shutdown", () =>
    {
        unsubscribeReady();
        disposeHandler?.();
    });

    if (announce())
    {
        unsubscribeReady();
    }
}
