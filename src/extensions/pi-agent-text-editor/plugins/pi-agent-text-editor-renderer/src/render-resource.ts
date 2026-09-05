import type { DiffModel } from "./diff-model.js";
import type { TextMutationPreviewResource } from "pi-agent-text-editor/api/mutation-preview";

export interface MutationRenderResource extends TextMutationPreviewResource {
  readonly model?: DiffModel;
  readonly cursorOffset?: number;
  /** Original mutation spans retained when final rendering uses an unscoped semantic diff. */
  readonly typingIdentity?: {
    readonly beforeRanges: readonly TextMutationPreviewResource["ranges"][number][];
    readonly ranges: readonly TextMutationPreviewResource["ranges"][number][];
  };
  /** Cached source lines used by append-only full-file projection. */
  readonly beforeLines?: readonly string[];
}
