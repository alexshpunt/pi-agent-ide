import { Type } from "typebox";
import { Value } from "typebox/value";

import type { TextEditorToolId } from "#src/api/plugin-protocol.js";

export type TextEditPipelineStage = "text-pre-edit" | "text-edit" | "text-post-edit";

export interface TextPreEditState<Input = unknown> {
  readonly cwd: string;
  readonly input: Input;
  readonly signal?: AbortSignal;
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
  addHandler(registration: TextEditHandlerRegistration): void;
  describe(description: string): void;
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
