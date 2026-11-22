import type { TextAnchorRejection } from "pi-agent-text";
export interface TextAnchorContextRange {
  readonly offset: number;
  readonly limit: number;
}

export interface TextAnchorInspectionRequest {
  readonly source: string;
  readonly anchors: readonly [string] | readonly [string, string];
  readonly kinds: readonly [readonly string[]] | readonly [readonly string[], readonly string[]];
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export type TextAnchorInspectionOutcome =
  | { readonly kind: "valid" }
  | {
      readonly kind: "invalid";
      readonly anchorIndex: number;
      readonly reason: string;
      /** Resolver-owned failure semantics. Only `stale` denotes a stale snapshot anchor. */
      readonly rejectionCode?: TextAnchorRejection["code"];
      readonly contextRange?: TextAnchorContextRange;
    }
  | { readonly kind: "failed"; readonly reason: string; readonly cause?: unknown };
