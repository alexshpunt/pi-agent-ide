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
    readonly changes: readonly TextEditPlanChange[];
    /** Map the same edits onto the transaction's snapshot, or refuse if it is incompatible. */
    readonly rebase?: (current: string) => readonly TextEditPlanChange[] | undefined;
  }[];
}
export interface TextEditPlanChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/**
 * Supplies native semantic edits. Called at the start of each attempt, including retries after a
 * snapshot mismatch or a guarded write conflict. A planner may reuse a compatible plan or throw
 * with code `SOURCE_CHANGED` to request another attempt.
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
  | {
      readonly stage: "text-pre-edit";
      /** Filter original inputs; matching calls run outside snapshot-only edit batches. */
      readonly when?: (input: unknown) => boolean;
      readonly handler: TextPreEditHandler;
    }
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
  Type.Object({
    stage: Type.Literal("text-pre-edit"),
    when: Type.Optional(handlerSchema),
    handler: handlerSchema,
  }),
  Type.Object({ stage: Type.Literal("text-edit"), handler: handlerSchema }),
  Type.Object({ stage: Type.Literal("text-post-edit"), handler: handlerSchema }),
]);

export function isTextEditHandlerRegistration(
  value: unknown,
): value is TextEditHandlerRegistration {
  return Value.Check(textEditHandlerRegistrationSchema, value);
}
