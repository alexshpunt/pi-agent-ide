import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import type { FileMutationBatchResult } from "#src/api/mutation-result.js";
import type { TextEditorToolId } from "#src/api/plugin-protocol.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type TextEditorRenderedTool = ToolDefinition<TSchema, FileMutationBatchResult>;

export type TextEditorToolRendererRegistration = Pick<
  TextEditorRenderedTool,
  "renderCall" | "renderResult" | "renderShell"
> & {
  readonly tool: TextEditorToolId;
  readonly fallback?: boolean;
  /** Select this renderer for matching tool arguments or results; unmatched values use the previous renderer. */
  readonly matches?: (value: unknown, phase: "call" | "result") => boolean;
};

const rendererFunctionSchema = Type.Function([], Type.Unknown());
const toolRendererRegistrationSchema = Type.Object({
  tool: Type.String({ pattern: "\\S" }),
  fallback: Type.Optional(Type.Boolean()),
  matches: Type.Optional(rendererFunctionSchema),
  renderCall: Type.Optional(rendererFunctionSchema),
  renderResult: Type.Optional(rendererFunctionSchema),
  renderShell: Type.Optional(Type.Union([Type.Literal("default"), Type.Literal("self")])),
});

export function isTextEditorToolRendererRegistration(
  value: unknown,
): value is TextEditorToolRendererRegistration {
  if (!Value.Check(toolRendererRegistrationSchema, value)) {
    return false;
  }

  return value.renderCall !== undefined || value.renderResult !== undefined;
}
