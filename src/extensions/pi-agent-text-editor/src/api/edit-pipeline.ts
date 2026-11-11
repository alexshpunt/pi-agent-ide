import { Type } from "typebox";
import { Value } from "typebox/value";

import type { TextEditorToolId } from "#src/api/plugin-protocol.ts";
import type { TextSemanticMutationHandler } from "#src/api/mutation-tool.ts";

export type TextEditPipelineStage = "text-pre-edit" | "text-edit" | "text-post-edit";

/** Host-plugin edit plan, checked against exact snapshots before any writes. */
export interface TextEditPlan {
  readonly files: readonly {
    readonly source: string;
    readonly expectedContent: string;
    readonly changes: readonly {
      readonly from: number;
      readonly to: number;
      readonly insert: string;
    }[];
  }[];
}
/**
 * Plans native semantic edits on the current text. The editor calls it at the start of each
 * attempt of the edit, as it resolves the targets of other edits there. When another process
 * writes a planned file before the edit writes it, the edit runs again and is planned again. A
 * planner that finds its own source changed throws an error with code `SOURCE_CHANGED` to get the
 * same new attempt.
 */
export type TextEditPlanner = () => Promise<TextEditPlan>;

export interface TextPreEditState<Input = unknown> {
  readonly cwd: string;
  readonly input: Input;
  /** Optional native semantic edits supplied by the owning plugin, not by tool arguments. */
  readonly planEdit?: TextEditPlanner;
  readonly signal?: AbortSignal;
  /** A validated diffStatuses contribution is added to each completed file's presentation. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TextEditState<Input = unknown, Result = unknown> extends TextPreEditState<Input> {
  readonly result: Result;
}

export type TextPreEditHandler = (
  state: TextPreEditState,
) => TextPreEditState | Promise<TextPreEditState>;

export type TextEditHandler = (state: TextEditState) => TextEditState | Promise<TextEditState>;

export type TextEditHandlerRegistration =
  | { readonly stage: "text-pre-edit"; readonly handler: TextPreEditHandler }
  | { readonly stage: "text-edit"; readonly handler: TextEditHandler }
  | { readonly stage: "text-post-edit"; readonly handler: TextEditHandler };

export interface TextEditorToolPluginApi {
  /** Handle selected invocations as anchored non-file effects before document writes. */
  addSemanticHandler(handler: TextSemanticMutationHandler): void;
  addHandler(registration: TextEditHandlerRegistration): void;
  describe(description: string): void;
  /** Add this plugin's text to one schema field of the tool, such as `path` or `text`. */
  describeField(field: string, description: string): void;
}

export interface TextEditPipelineFailure {
  readonly code: "PLUGIN_FAILED";
  readonly pluginId: string;
  readonly tool: TextEditorToolId;
  readonly stage: TextEditPipelineStage;
  readonly message: string;
  readonly cause: unknown;
}

export type TextEditExecutionOutcome<Input = unknown, Result = unknown> =
  | { readonly kind: "completed"; readonly state: TextEditState<Input, Result> }
  | { readonly kind: "failed"; readonly failure: TextEditPipelineFailure };

const handlerSchema = Type.Function([], Type.Unknown());
const textEditHandlerRegistrationSchema = Type.Union([
  Type.Object({ stage: Type.Literal("text-pre-edit"), handler: handlerSchema }),
  Type.Object({ stage: Type.Literal("text-edit"), handler: handlerSchema }),
  Type.Object({ stage: Type.Literal("text-post-edit"), handler: handlerSchema }),
]);

export function isTextEditHandlerRegistration(
  value: unknown,
): value is TextEditHandlerRegistration {
  return Value.Check(textEditHandlerRegistrationSchema, value);
}
