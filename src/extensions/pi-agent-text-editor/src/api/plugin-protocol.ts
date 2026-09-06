import { isResourceResolver, type ResourceResolver } from "pi-agent-resource";
import {
  isTextAnchorResolver,
  type TextAnchorResolver,
  type TextPresenterRegistration,
  type TextTargetResolutionAttempt,
  type TextTargetResolver,
} from "pi-agent-text";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type {
  TextAnchorInspectionOutcome,
  TextAnchorInspectionRequest,
} from "#src/api/anchor-inspection.js";
import type { TextEditCompletionListener } from "#src/api/edit-completion.js";
import type { TextEditorToolPluginApi } from "#src/api/edit-pipeline.js";
import type { TextMutationGuardRegistration } from "#src/api/mutation-guard.js";
import type {
  TextMutationPreviewOutcome,
  TextMutationPreviewRequest,
} from "#src/api/mutation-preview.js";
import type {
  TextMutationToolListener,
  TextMutationToolRegistration,
} from "#src/api/mutation-tool.js";
import type { TextEditorToolRendererRegistration } from "#src/api/tool-renderer.js";

export const TEXT_EDITOR_PROTOCOL = "pi-agent-text-editor";

export const TEXT_EDITOR_API_VERSION = 17;

export const TEXT_POSITION_ANCHOR_KIND = "pi-agent-text-editor/position";

export const TEXT_SEARCH_ANCHOR_KIND = "pi-agent-text-editor/search";

export const TEXT_EDITOR_CORE_READY_EVENT = `${TEXT_EDITOR_PROTOCOL}/core/ready`;

export const TEXT_EDITOR_PLUGIN_REGISTER_EVENT = `${TEXT_EDITOR_PROTOCOL}/plugin/register`;

export type TextEditorToolId = string;

export type PromptDescriptionSource = string | (() => string | undefined);

export interface ResourceResolverRegistration {
  readonly resolver: ResourceResolver;
  readonly priority?: number;
}

export type TextAnchorType = "major" | "auxiliary" | "constant";

export interface TextAnchorResourceResolverContext {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export type TextAnchorResourceResolutionAttempt = TextTargetResolutionAttempt;

export interface TextAnchorResourceResolver extends TextTargetResolver {}

export interface TextAnchorResolverRegistration {
  readonly resolver: TextAnchorResolver;
  readonly resources?: TextAnchorResourceResolver;
  readonly kind: string;
  readonly type: TextAnchorType;
  readonly priority?: number;
  /** Whether this resolver's description appears in the text-editor anchor prompt. Default: true. */
  readonly describeInPrompt?: boolean;
}

export interface TextEditorCoreReady {
  readonly protocol: typeof TEXT_EDITOR_PROTOCOL;
  readonly apiVersion: typeof TEXT_EDITOR_API_VERSION;
}

/** Generic limits plus one plugin-owned recovery config value. */
export interface TextEditorRecoveryConfigSection {
  readonly contextLines: number;
  readonly timeoutMs: number;
  readonly settings: unknown;
}
export interface TextEditorPluginApi {
  addResolver(registration: ResourceResolverRegistration): void;
  inspectTextAnchors(request: TextAnchorInspectionRequest): Promise<TextAnchorInspectionOutcome>;
  addAnchorResolver(registration: TextAnchorResolverRegistration): void;
  /** Reads this plugin's project recovery subsection. */
  recoveryConfig(section: string): TextEditorRecoveryConfigSection;
  addTextPresenter(registration: TextPresenterRegistration): void;
  addMutationTool(registration: TextMutationToolRegistration): void;
  addMutationGuard(registration: TextMutationGuardRegistration): void;
  addToolRenderer(registration: TextEditorToolRendererRegistration): void;
  onMutationTool(listener: TextMutationToolListener): () => void;
  onDidEdit(listener: TextEditCompletionListener): () => void;
  previewMutation(request: TextMutationPreviewRequest): Promise<TextMutationPreviewOutcome>;
  describe(description: PromptDescriptionSource): void;
  tool(tool: TextEditorToolId): TextEditorToolPluginApi;
}

export interface TextEditorPlugin {
  readonly protocol: typeof TEXT_EDITOR_PROTOCOL;
  readonly apiVersion: typeof TEXT_EDITOR_API_VERSION;
  readonly id: string;
  readonly setup: (api: TextEditorPluginApi) => void | Promise<void>;
}

export interface TextEditorPluginRegistrationRequest {
  readonly plugin: TextEditorPlugin;
  accept(registration: Promise<void>): void;
}

const functionSchema = Type.Function([], Type.Unknown());
const textAnchorResourceResolverSchema = Type.Object(
  { tryResolve: functionSchema },
  { additionalProperties: true },
);
const textTargetPositionSchema = Type.Object({
  lineNumber: Type.Integer({ minimum: 1 }),
  column: Type.Integer({ minimum: 0 }),
});
const textTargetRangeSchema = Type.Object({
  start: textTargetPositionSchema,
  end: textTargetPositionSchema,
  linewise: Type.Optional(Type.Boolean()),
});
const textTargetSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  ranges: Type.Optional(Type.Array(textTargetRangeSchema)),
});
const textAnchorResourceResolutionAttemptSchema = Type.Union([
  Type.Object({ kind: Type.Literal("not-handled") }, { additionalProperties: true }),
  Type.Object(
    {
      kind: Type.Literal("resolved"),
      targets: Type.Array(textTargetSchema, { minItems: 1 }),
    },
    { additionalProperties: true },
  ),
  Type.Object(
    {
      kind: Type.Literal("rejected"),
      rejection: Type.Object({
        code: Type.Union([
          Type.Literal("invalid"),
          Type.Literal("stale"),
          Type.Literal("missing"),
          Type.Literal("ambiguous"),
        ]),
        reason: Type.String(),
        contextRange: Type.Optional(
          Type.Object({
            offset: Type.Number(),
            limit: Type.Number(),
          }),
        ),
      }),
    },
    { additionalProperties: true },
  ),
  Type.Object(
    {
      kind: Type.Literal("failed"),
      error: Type.Unknown(),
    },
    { additionalProperties: true },
  ),
]);
const textEditorToolIdSchema = Type.String({ pattern: "\\S" });
const resourceResolverRegistrationSchema = Type.Object({
  resolver: Type.Unknown(),
  priority: Type.Optional(Type.Number()),
});
const textAnchorResolverRegistrationSchema = Type.Object({
  resolver: Type.Unknown(),
  resources: Type.Optional(Type.Unknown()),
  kind: Type.String({ pattern: "\\S" }),
  type: Type.Union([Type.Literal("major"), Type.Literal("auxiliary"), Type.Literal("constant")]),
  priority: Type.Optional(Type.Number()),
});
const textEditorCoreReadySchema = Type.Object({
  protocol: Type.Literal(TEXT_EDITOR_PROTOCOL),
  apiVersion: Type.Literal(TEXT_EDITOR_API_VERSION),
});
const textEditorPluginSchema = Type.Object({
  protocol: Type.Literal(TEXT_EDITOR_PROTOCOL),
  apiVersion: Type.Literal(TEXT_EDITOR_API_VERSION),
  id: Type.String(),
  setup: functionSchema,
});
const textEditorPluginRegistrationRequestSchema = Type.Object({
  plugin: textEditorPluginSchema,
  accept: functionSchema,
});

export function isTextEditorToolId(value: unknown): value is TextEditorToolId {
  return Value.Check(textEditorToolIdSchema, value);
}

export function isResourceResolverRegistration(
  value: unknown,
): value is ResourceResolverRegistration {
  if (!Value.Check(resourceResolverRegistrationSchema, value)) {
    return false;
  }

  const registration = value as Record<PropertyKey, unknown>;
  return (
    isResourceResolver(registration.resolver) &&
    (!("priority" in registration) || typeof registration.priority === "number")
  );
}

export function isTextAnchorResolverRegistration(
  value: unknown,
): value is TextAnchorResolverRegistration {
  if (!Value.Check(textAnchorResolverRegistrationSchema, value)) {
    return false;
  }

  const registration = value as Record<PropertyKey, unknown>;
  return (
    isTextAnchorResolver(registration.resolver) &&
    (!("resources" in registration) ||
      Value.Check(textAnchorResourceResolverSchema, registration.resources)) &&
    (!("priority" in registration) || typeof registration.priority === "number")
  );
}

export function isTextAnchorResourceResolutionAttempt(
  value: unknown,
): value is TextAnchorResourceResolutionAttempt {
  return Value.Check(textAnchorResourceResolutionAttemptSchema, value);
}

export function isTextEditorCoreReady(value: unknown): value is TextEditorCoreReady {
  return Value.Check(textEditorCoreReadySchema, value);
}

export function isTextEditorPlugin(value: unknown): value is TextEditorPlugin {
  return Value.Check(textEditorPluginSchema, value);
}

export function isTextEditorPluginRegistrationRequest(
  value: unknown,
): value is TextEditorPluginRegistrationRequest {
  return Value.Check(textEditorPluginRegistrationRequestSchema, value);
}
