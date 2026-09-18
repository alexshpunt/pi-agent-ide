import type { MutationDiffStatus } from "pi-agent-text-editor/api/mutation-result";
import type { DiffModel } from "./diff-model.js";
import type { TextMutationPreviewResource } from "pi-agent-text-editor/api/mutation-preview";

export interface MutationRenderResource extends TextMutationPreviewResource {
  readonly model?: DiffModel;
  readonly diffStatuses?: readonly MutationDiffStatus[];

  /** Original spans owned by sibling batch calls, excluded from this local diff. */
  readonly diffPeerRanges?: readonly { readonly from: number; readonly to: number }[];
  /** Exact final line ownership when postprocessing left the requested batch text unchanged. */
  readonly finalLineOwnership?: {
    readonly own: readonly number[];
    readonly peers: readonly number[];
  };
  readonly cursorOffset?: number;
  /** Original mutation spans retained when final rendering uses an unscoped semantic diff. */
  readonly typingIdentity?: {
    readonly beforeRanges: readonly TextMutationPreviewResource["ranges"][number][];
    readonly ranges: readonly TextMutationPreviewResource["ranges"][number][];
  };
  /** Cached source lines used by append-only full-file projection. */
  readonly beforeLines?: readonly string[];
}
