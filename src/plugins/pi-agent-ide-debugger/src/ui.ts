import type {
  DebugEvaluation,
  DebugSessionSnapshot,
} from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

/** Extract one immutable snapshot from a debugger semantic-action receipt. */
export function debuggerSnapshotFromResult(details: unknown): DebugSessionSnapshot | undefined {
  const semantic = semanticActionFromResult(details);
  if (semantic === undefined) return undefined;
  const snapshot = semantic.snapshot;
  return typeof snapshot === "object" && snapshot !== null
    ? (snapshot as DebugSessionSnapshot)
    : undefined;
}

/** Extract an evaluation result from a debugger semantic-action receipt. */
export function debuggerEvaluationFromResult(details: unknown): DebugEvaluation | undefined {
  const semantic = semanticActionFromResult(details);
  if (semantic === undefined) return undefined;
  const evaluation = semantic.evaluation;
  if (
    typeof evaluation !== "object" ||
    evaluation === null ||
    !("expression" in evaluation) ||
    typeof evaluation.expression !== "string" ||
    !("result" in evaluation) ||
    typeof evaluation.result !== "string" ||
    !("variablesReference" in evaluation) ||
    typeof evaluation.variablesReference !== "number"
  ) {
    return undefined;
  }
  return {
    expression: evaluation.expression,
    result: evaluation.result,
    variablesReference: evaluation.variablesReference,
    ...("type" in evaluation && typeof evaluation.type === "string"
      ? { type: evaluation.type }
      : {}),
  };
}

/** Extract the reason of a failed debugger action, such as a refused start. */
export function debuggerFailureFromResult(details: unknown): string | undefined {
  const semantic = semanticActionFromResult(details);
  const error = semantic?.ok === false ? semantic.error : undefined;
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : undefined;
}

function semanticActionFromResult(details: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const metadata = (details as { readonly metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const semantic = (metadata as { readonly semanticAction?: unknown }).semanticAction;
  return typeof semantic === "object" && semantic !== null
    ? (semantic as Readonly<Record<string, unknown>>)
    : undefined;
}
