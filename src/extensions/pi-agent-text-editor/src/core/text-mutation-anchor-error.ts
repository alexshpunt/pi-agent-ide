import { TextMutationInputError } from "#src/api/mutation-tool.ts";
import type { AnchorCandidates } from "#src/core/anchor-candidates.ts";
import { TextAnchorResolutionError } from "#src/core/text-anchor-registry.ts";

export class TextMutationAnchorResolutionError extends Error {
  public constructor(
    readonly toolName: string,
    readonly field: string,
    readonly source: string,
    readonly anchor: string,
    readonly resolution: TextAnchorResolutionError,
  ) {
    super(resolution.message, { cause: resolution });
  }
}

/** A resolved selection is not usable as a single boundary; present its matches on refusal. */
export class TextMutationAnchorCandidatesError extends TextMutationInputError {
  public constructor(
    code: string,
    message: string,
    readonly candidates: AnchorCandidates,
  ) {
    super(code, message);
  }
}

/** Groups every rejected anchor field from one mutation call. */
export class TextMutationAnchorAggregateError extends AggregateError {
  public constructor(readonly failures: readonly TextMutationAnchorResolutionError[]) {
    super(failures, `${failures.length} text anchors could not resolve`);
  }
}

export function contextualizeTextMutationAnchorError(
  error: unknown,
  toolName: string,
  field: string,
  source: string,
  anchor: string,
): unknown {
  return error instanceof TextAnchorResolutionError
    ? new TextMutationAnchorResolutionError(toolName, field, source, anchor, error)
    : error;
}
