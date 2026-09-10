import type { TextAnchorRecoveryCandidate } from "pi-agent-text";
import type { MutationFormatting, AppliedTextChange } from "#src/api/mutation-result.js";

/** Plain recovery data from the same anchor resolver used by standalone mutations. */
export interface ScriptAnchorRecovery {
  readonly path: string;
  readonly field: string;
  readonly anchor: string;
  readonly status: "candidates" | "unavailable" | "timed-out" | "failed";
  readonly candidates: readonly TextAnchorRecoveryCandidate[];
  readonly total: number;
}

/** Plain resource data crossing the script bridge, independent of renderer objects. */
export interface ScriptMutationFile {
  readonly source: string;
  readonly before: string | null;
  readonly after: string;
  readonly action: string;
  readonly changes: readonly AppliedTextChange[];
  readonly formatting: MutationFormatting;
}

/** Shared mutation execution outcome before model-facing formatting. */
export interface ScriptMutationOutcome {
  readonly operation: string;
  readonly ok: boolean;
  readonly effect: "not-applied" | "applied" | "unknown";
  readonly files: readonly ScriptMutationFile[];
  readonly completed: readonly string[];
  readonly recoveries?: readonly ScriptAnchorRecovery[];
  /** Structured contributions from configured IDE mutation handlers. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly errors: readonly {
    readonly source: string;
    readonly code: string;
    readonly message: string;
  }[];
}
