import {
    type AgentContent,
    type ImageContent,
    isResourceResolver,
    type ResourceResolver,
    type ResourceResolverContext,
    type TextContent,
} from "pi-agent-resource";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { ToolDefinition, TruncationResult } from "@earendil-works/pi-coding-agent";
import type { TextDocument, TextLine, TextLinePresentation, TextPresenterRegistration } from "pi-agent-text";

export type ReadPipelineStage = "pre-read" | "read" | "post-read";

export type ReadContentKind = "text" | "other";

export interface ReadRequest
{
    readonly path?: string;
    readonly offset?: number;
    readonly limit?: number;
}

export interface ReadFailure
{
    readonly code:
        | "INVALID_REQUEST"
        | "INVALID_RESOLVER_RESULT"
        | "INVALID_RESOURCE_CONTENT"
        | "NO_RESOLVER"
        | "PIPELINE_FAILED"
        | "READ_FAILED"
        | "RESOLVE_FAILED"
        | "UNSUPPORTED_CAPABILITY"
        | "UNSUPPORTED_CONTENT"
        | "UNSUPPORTED_RANGE";
    readonly source?: string;
    readonly resolverId?: string;
    readonly pluginId?: string;
    readonly stage?: ReadPipelineStage;
    readonly message: string;
    readonly cause?: unknown;
}

export type ReadResultRenderer = NonNullable<ToolDefinition["renderResult"]>;

export interface ResourceResolverRegistration
{
    readonly resolver: ResourceResolver;
    readonly priority?: number;
    readonly renderResult?: ReadResultRenderer;
    readonly preserveTruncatedOutput?: boolean;
}

export type ReadTextLinePresentation = TextLinePresentation;

export type ReadTextLine = TextLine;

export type ReadTextSnapshot = TextDocument;

interface ReadStateBase
{
    readonly source: string;
    readonly resolvedBy: string;
    readonly preserveTruncatedOutput: boolean;
    readonly textMode: "final" | "normal";
}

export interface ReadTextState extends ReadStateBase
{
    readonly content: readonly [TextContent];
    readonly contentKind: "text";
    readonly text: ReadTextSnapshot;
}

export interface ReadNativeState extends ReadStateBase
{
    readonly content: AgentContent;
    readonly contentKind: "other";
    readonly text?: never;
}

export type ReadState = ReadTextState | ReadNativeState;

export interface ReadPipelineContext
{
    readonly request: ReadRequest;
    readonly resolverContext: ResourceResolverContext;
    readonly state?: ReadState;
    readonly result?: ReadToolResult;
}

export interface UnsupportedContentBlockDetail
{
    readonly index: number;
    readonly kind: string;
}

export interface UnsupportedContentDetails
{
    readonly unsupportedContentBlocks?: readonly [
        UnsupportedContentBlockDetail,
        ...UnsupportedContentBlockDetail[],
    ];
}

export interface ReadResultDetails extends UnsupportedContentDetails
{
    readonly source?: string;
    readonly resolvedBy?: string;
    readonly startLine?: number;
    readonly endLine?: number;
    readonly totalLines?: number;
    readonly truncation?: TruncationResult;
    readonly temporarySource?: string;
    readonly lines?: readonly ReadTextLine[];
    readonly failure?: ReadFailure;
}

export interface ReadToolResult
{
    readonly content: (TextContent | ImageContent)[];
    readonly details: ReadResultDetails;
    readonly isError?: boolean;
}

export type ReadStageOutcome =
    | { readonly kind: "continue"; readonly context: ReadPipelineContext; }
    | { readonly kind: "return"; readonly result: ReadToolResult; };

export type ReadPreReadHandler = ReadPipelineHandler;

export type ReadHandler = ReadPipelineHandler;

export type ReadPostReadHandler = ReadPipelineHandler;

export type ReadPipelineHandler = (
    context: ReadPipelineContext,
) => ReadStageOutcome | Promise<ReadStageOutcome>;

export interface ReadHandlerWhen
{
    readonly resolvedBy: string;
    readonly contentKind: "text" | "any";
}

export type ReadHandlerRegistration =
    | { readonly stage: "pre-read"; readonly handler: ReadPreReadHandler; }
    | { readonly stage: "read"; readonly when: ReadHandlerWhen; readonly handler: ReadHandler; }
    | { readonly stage: "post-read"; readonly handler: ReadPostReadHandler; };

export type PromptDescriptionSource = string | (() => string | undefined);

export interface ReadToolPluginApi
{
    read(request: ReadRequest, context: ResourceResolverContext): Promise<ReadToolResult>;
    addResolver(registration: ResourceResolverRegistration): void;
    addHandler(registration: ReadHandlerRegistration): void;
    addTextPresenter(registration: TextPresenterRegistration): void;
    describe(description: PromptDescriptionSource): void;
}

const functionSchema = Type.Function([], Type.Unknown());
const resourceResolverRegistrationSchema = Type.Object({
    resolver: Type.Unknown(),
    priority: Type.Optional(Type.Number()),
    renderResult: Type.Optional(functionSchema),
    preserveTruncatedOutput: Type.Optional(Type.Boolean()),
});
const readHandlerWhenSchema = Type.Object({
    resolvedBy: Type.String({ pattern: "\\S" }),
    contentKind: Type.Union([Type.Literal("text"), Type.Literal("any")]),
});
const readHandlerRegistrationSchema = Type.Union([
    Type.Object({ stage: Type.Literal("pre-read"), handler: functionSchema }),
    Type.Object({
        stage: Type.Literal("read"),
        when: readHandlerWhenSchema,
        handler: functionSchema,
    }),
    Type.Object({ stage: Type.Literal("post-read"), handler: functionSchema }),
]);

export function isResourceResolverRegistration(value: unknown): value is ResourceResolverRegistration
{
    if (!Value.Check(resourceResolverRegistrationSchema, value))
    {
        return false;
    }

    const registration = value as Record<PropertyKey, unknown>;

    if (!isResourceResolver(registration.resolver))
    {
        return false;
    }

    return registration.resolver.id !== "any"
        && (!("priority" in registration) || typeof registration.priority === "number")
        && (!("renderResult" in registration) || typeof registration.renderResult === "function");
}

export function isReadHandlerRegistration(value: unknown): value is ReadHandlerRegistration
{
    return Value.Check(readHandlerRegistrationSchema, value);
}
