/** A position with a one-based line and zero-based column. */
export interface TextSelectionPosition {
  readonly lineNumber: number;
  readonly column: number;
}

/** A character range in a text document. */
export interface TextSelectionRange {
  readonly start: TextSelectionPosition;
  readonly end: TextSelectionPosition;
  /** Treat a whole-line match as complete lines during mutation. */
  readonly linewise?: boolean;
}

/** A source and optional ranges selected by a typed text anchor. */
export interface TextTarget {
  readonly source: string;
  readonly ranges?: readonly TextSelectionRange[];
}

export interface TextTargetResolverContext {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export type TextTargetResolutionAttempt =
  | { readonly kind: "not-handled" }
  | { readonly kind: "resolved"; readonly targets: readonly TextTarget[] }
  | {
      readonly kind: "rejected";
      readonly rejection: {
        readonly code: "invalid" | "stale" | "missing" | "ambiguous";
        readonly reason: string;
        readonly contextRange?: { readonly offset: number; readonly limit: number };
      };
    }
  | { readonly kind: "failed"; readonly error: unknown };

/** Resolves an anchor/resource value into typed text targets. */
export interface TextTargetResolver {
  readonly id: string;
  tryResolve(
    value: string,
    context: TextTargetResolverContext,
  ): TextTargetResolutionAttempt | Promise<TextTargetResolutionAttempt>;
}

/** Validates an untrusted runtime result from a text target resolver. */
export function isTextTargetResolutionAttempt(
  value: unknown,
): value is TextTargetResolutionAttempt {
  if (value === null || typeof value !== "object") return false;
  const attempt = value as Record<string, unknown>;
  if (attempt.kind === "not-handled") return true;
  if (attempt.kind === "failed") return "error" in attempt;
  if (attempt.kind === "rejected") {
    const rejection = attempt.rejection;
    return (
      rejection !== null &&
      typeof rejection === "object" &&
      ["invalid", "stale", "missing", "ambiguous"].includes(
        (rejection as Record<string, unknown>).code as string,
      ) &&
      typeof (rejection as Record<string, unknown>).reason === "string"
    );
  }
  if (
    attempt.kind !== "resolved" ||
    !Array.isArray(attempt.targets) ||
    attempt.targets.length === 0
  ) {
    return false;
  }
  return attempt.targets.every((target) => {
    if (target === null || typeof target !== "object") return false;
    const source = (target as Record<string, unknown>).source;
    const ranges = (target as Record<string, unknown>).ranges;
    return (
      typeof source === "string" &&
      source.length > 0 &&
      (ranges === undefined || (Array.isArray(ranges) && ranges.every(isTextSelectionRange)))
    );
  });
}

function isTextSelectionRange(value: unknown): value is TextSelectionRange {
  if (value === null || typeof value !== "object") return false;
  const range = value as Record<string, unknown>;
  return (
    isTextSelectionPosition(range.start) &&
    isTextSelectionPosition(range.end) &&
    (range.linewise === undefined || typeof range.linewise === "boolean")
  );
}

function isTextSelectionPosition(value: unknown): value is TextSelectionPosition {
  if (value === null || typeof value !== "object") return false;
  const position = value as Record<string, unknown>;
  return (
    Number.isInteger(position.lineNumber) &&
    (position.lineNumber as number) >= 1 &&
    Number.isInteger(position.column) &&
    (position.column as number) >= 0
  );
}
