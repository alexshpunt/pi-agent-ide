export interface TextMutationPreviewRequest {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface TextMutationPreviewRange {
  readonly from: number;
  readonly to: number;
}

export type TextMutationPreviewRanges = readonly TextMutationPreviewRange[];

export interface TextMutationPreviewResource {
  readonly path: string;
  readonly existed?: boolean;
  readonly beforeRanges?: TextMutationPreviewRanges;
  readonly link?: string;
  readonly ranges: readonly TextMutationPreviewRange[];
  readonly beforeContent: string;
  readonly afterContent: string;
}

export type TextMutationPreviewOutcome =
  | { readonly kind: "completed"; readonly resources: readonly TextMutationPreviewResource[] }
  | { readonly kind: "failed"; readonly reason: string };
