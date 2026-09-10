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
import type {
  TextDocument,
  TextLine,
  TextLinePresentation,
  TextLinePresenter,
  TextTargetResolver,
} from "pi-agent-text";

export type ReadPipelineStage = "pre-read" | "read" | "post-read";

export type ReadContentKind = "text" | "other";

export interface ReadRequest {
  readonly path?: string;
  readonly offset?: number;
  readonly limit?: number;
  /** Requested presentation views; without them text reads return raw content. */
  readonly views?: readonly string[];
}

export interface ReadFailure {
  readonly code:
    | "FRAGMENT_FAILED"
    | "INVALID_REQUEST"
    | "INVALID_RESOLVER_RESULT"
    | "INVALID_RESOURCE_CONTENT"
    | "NO_FRAGMENT_RESOLVER"
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

export interface ResourceResolverRegistration {
  readonly resolver: ResourceResolver;
  readonly priority?: number;
  readonly renderResult?: ReadResultRenderer;
  readonly preserveTruncatedOutput?: boolean;
}

export interface TextTargetResolverRegistration {
  readonly resolver: TextTargetResolver;
  readonly priority?: number;
}

/** Input for resolving the anchor fragment of an anchored read source. */
export interface ReadFragmentContext {
  readonly source: string;
  readonly fragment: string;
  readonly text: TextDocument;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

/** One fragment resolver's outcome for an anchored read. */
export type ReadFragmentResolution =
  | { readonly kind: "resolved"; readonly originLine: number }
  | { readonly kind: "not-handled" }
  | { readonly kind: "failed"; readonly message: string };

export interface FragmentResolverRegistration {
  readonly id: string;
  readonly priority?: number;
  resolve(context: ReadFragmentContext): ReadFragmentResolution | Promise<ReadFragmentResolution>;
}

/**
 * One named presentation view. A view collects line annotations (prefixes, suffixes,
 * extra rows) that the read output shows only when the request lists the view name.
 * Several plugins may contribute presenters under one view name.
 */
export interface ReadViewRegistration {
  readonly view: string;
  /** Requested views whose complete presentation this view already provides. */
  readonly includes?: readonly string[];
  readonly presenter: TextLinePresenter;
  readonly priority?: number;
}

export type ReadTextLinePresentation = TextLinePresentation;

export type ReadTextLine = TextLine;

export type ReadTextSnapshot = TextDocument;

interface ReadStateBase {
  readonly source: string;
  readonly resolvedBy: string;
  readonly preserveTruncatedOutput: boolean;
  readonly textMode: "final" | "normal";
}

export interface ReadTextState extends ReadStateBase {
  readonly content: readonly [TextContent];
  readonly contentKind: "text";
  readonly text: ReadTextSnapshot;
}

export interface ReadNativeState extends ReadStateBase {
  readonly content: AgentContent;
  readonly contentKind: "other";
  readonly text?: never;
}

export type ReadState = ReadTextState | ReadNativeState;

export interface ReadPipelineContext {
  /** Data execution keeps full requested content; presentation handlers must not compact it. */
  readonly audience?: "agent" | "script";
  readonly request: ReadRequest;
  readonly resolverContext: ResourceResolverContext;
  readonly state?: ReadState;
  readonly result?: ReadToolResult;
}

export interface UnsupportedContentBlockDetail {
  readonly index: number;
  readonly kind: string;
}

export interface UnsupportedContentDetails {
  readonly unsupportedContentBlocks?: readonly [
    UnsupportedContentBlockDetail,
    ...UnsupportedContentBlockDetail[],
  ];
}

export interface ReadResultDetails extends UnsupportedContentDetails {
  /** Explicit diagnostic checks; completed empty reports need no content panel. */
  readonly diagnosticCheck?: {
    readonly complete: boolean;
    readonly count: number;
    readonly sources: readonly string[];
  };
  readonly byteOffset?: number;
  readonly byteLength?: number;
  readonly totalBytes?: number;
  /** Every selected target result for script reads spanning multiple resources or ranges. */
  readonly resources?: readonly ReadToolResult[];
  readonly source?: string;
  readonly resolvedBy?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly totalLines?: number;
  readonly truncation?: TruncationResult;
  readonly temporarySource?: string;
  readonly lines?: readonly ReadTextLine[];
  /** Requested view names that no registration backed; they were ignored. */
  readonly ignoredViews?: readonly string[];
  readonly failure?: ReadFailure;
}

/** Plain selected source data for computation, separate from formatted tool content. */
export type ReadScriptData =
  | {
      readonly kind: "bytes";
      readonly source: string;
      readonly byteOffset: number;
      readonly byteLength: number;
      readonly totalBytes: number;
      readonly bytes: readonly number[];
    }
  | {
      readonly kind: "text";
      readonly source: string;
      readonly content: string;
      readonly lines: readonly ReadTextLine[];
      readonly startLine: number;
      readonly endLine: number;
      readonly totalLines: number;
    }
  | {
      readonly kind: "native";
      readonly source: string;
      readonly blocks: readonly AgentContent[number][];
    }
  | {
      readonly kind: "resources";
      readonly source?: string;
      readonly resources: readonly ReadScriptData[];
    };
export interface ReadToolResult {
  /** Present only for script execution; never reconstructed from rendered text. */
  readonly script?: ReadScriptData;
  readonly content: (TextContent | ImageContent)[];
  readonly details: ReadResultDetails;
  readonly isError?: boolean;
}

export type ReadStageOutcome =
  | { readonly kind: "continue"; readonly context: ReadPipelineContext }
  | { readonly kind: "return"; readonly result: ReadToolResult };

export type ReadPreReadHandler = ReadPipelineHandler;

export type ReadHandler = ReadPipelineHandler;

export type ReadPostReadHandler = ReadPipelineHandler;

export type ReadPipelineHandler = (
  context: ReadPipelineContext,
) => ReadStageOutcome | Promise<ReadStageOutcome>;

export interface ReadHandlerWhen {
  readonly resolvedBy: string;
  readonly contentKind: "text" | "any";
}

export type ReadHandlerRegistration =
  | { readonly stage: "pre-read"; readonly handler: ReadPreReadHandler }
  | { readonly stage: "read"; readonly when: ReadHandlerWhen; readonly handler: ReadHandler }
  | { readonly stage: "post-read"; readonly handler: ReadPostReadHandler };

export type PromptDescriptionSource = string | (() => string | undefined);

/** Remaining text budget for a format-aware view of already-read data. */
export interface ReadOutputBudget {
  readonly maxBytes: number;
  readonly maxLines: number;
}
/** Reduces presentation without reading a newer snapshot or changing script data. */
export type ReadOutputReducer = (
  result: ReadToolResult,
  context: ResourceResolverContext,
  budget: ReadOutputBudget,
) => Promise<ReadToolResult | undefined>;
export interface ReadToolPluginApi {
  /** Registers a format-aware reducer shared by read and composed output. */
  addOutputReducer(reducer: ReadOutputReducer): void;
  /** Attempts a compact presentation from the recorded snapshot without rereading its source. */
  reduceOutput(
    result: ReadToolResult,
    context: ResourceResolverContext,
    budget: ReadOutputBudget,
  ): Promise<ReadToolResult | undefined>;
  /** Stores complete output for follow-up read access until this runtime is disposed. */
  saveTemporary(text: string): Promise<string>;
  /** Executes the shared pipeline; script results are not clipped to the agent output budget. */
  read(
    request: ReadRequest,
    context: ResourceResolverContext,
    audience?: "agent" | "script",
  ): Promise<ReadToolResult>;
  addResolver(registration: ResourceResolverRegistration): void;
  addTargetResolver(registration: TextTargetResolverRegistration): void;
  addHandler(registration: ReadHandlerRegistration): void;
  /** Registers a named view whose presenter runs when a request lists the view. */
  addView(registration: ReadViewRegistration): void;
  addFragmentResolver(registration: FragmentResolverRegistration): void;
  describe(description: PromptDescriptionSource): void;

  /** Adds an operational rule to the read tool's system-prompt guidelines. */
  addPromptGuideline(guideline: PromptDescriptionSource): void;
}

const functionSchema = Type.Function([], Type.Unknown());
const resourceResolverRegistrationSchema = Type.Object({
  resolver: Type.Unknown(),
  priority: Type.Optional(Type.Number()),
  renderResult: Type.Optional(functionSchema),
  preserveTruncatedOutput: Type.Optional(Type.Boolean()),
});
const textTargetResolverRegistrationSchema = Type.Object({
  resolver: Type.Unknown(),
  priority: Type.Optional(Type.Number()),
});
const fragmentResolverRegistrationSchema = Type.Object({
  id: Type.String({ pattern: "\\S" }),
  priority: Type.Optional(Type.Number()),
  resolve: functionSchema,
});
const viewRegistrationSchema = Type.Object({
  view: Type.String({ pattern: "\\S" }),
  includes: Type.Optional(Type.Array(Type.String({ pattern: "\\S" }))),
  presenter: Type.Object({ id: Type.String(), present: functionSchema }),
  priority: Type.Optional(Type.Number()),
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

export function isTextTargetResolverRegistration(
  value: unknown,
): value is TextTargetResolverRegistration {
  if (!Value.Check(textTargetResolverRegistrationSchema, value)) return false;
  const registration = value as { resolver?: unknown };
  const resolver = registration.resolver as { id?: unknown; tryResolve?: unknown };
  return (
    typeof resolver.id === "string" &&
    resolver.id.length > 0 &&
    typeof resolver.tryResolve === "function" &&
    (!("priority" in registration) || typeof registration.priority === "number")
  );
}

export function isResourceResolverRegistration(
  value: unknown,
): value is ResourceResolverRegistration {
  if (!Value.Check(resourceResolverRegistrationSchema, value)) {
    return false;
  }

  const registration = value as Record<PropertyKey, unknown>;

  if (!isResourceResolver(registration.resolver)) {
    return false;
  }

  return (
    registration.resolver.id !== "any" &&
    (!("priority" in registration) || typeof registration.priority === "number") &&
    (!("renderResult" in registration) || typeof registration.renderResult === "function")
  );
}

export function isReadHandlerRegistration(value: unknown): value is ReadHandlerRegistration {
  return Value.Check(readHandlerRegistrationSchema, value);
}

export function isReadViewRegistration(value: unknown): value is ReadViewRegistration {
  return Value.Check(viewRegistrationSchema, value);
}

export function isFragmentResolverRegistration(
  value: unknown,
): value is FragmentResolverRegistration {
  return Value.Check(fragmentResolverRegistrationSchema, value);
}

export function isReadFragmentResolution(value: unknown): value is ReadFragmentResolution {
  if (!isRecord(value)) {
    return false;
  }

  if (value.kind === "not-handled") {
    return true;
  }

  if (value.kind === "failed") {
    return typeof value.message === "string" && value.message.length > 0;
  }

  return value.kind === "resolved" && typeof value.originLine === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export { readParameters } from "#src/api/read-parameters.js";
