import type { DiffModel } from "./diff-model.js";
import type { TextMutationPreviewResource } from "pi-agent-text-editor/api/mutation-preview";

export interface MutationRenderResource extends TextMutationPreviewResource {
  readonly model?: DiffModel;
  readonly cursorOffset?: number;
}
