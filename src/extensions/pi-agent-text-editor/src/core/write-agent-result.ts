import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { TextEditCompletion } from "#src/api/edit-completion.js";
import type { FileMutationBatchResult, FileMutationResult } from "#src/api/mutation-result.js";
import { mutationOutcome } from "./structured-result.js";

/** Keep hook feedback and short problem notices without copying diagnostics, diffs, or file text. */
export function writeProblemNotices(results: readonly FileMutationResult[]): string[] {
  const notices = new Set<string>();
  for (const result of results) {
    if (result.data.formatting?.status === "failed") notices.add("Formatting failed.");
    if (
      result.data.formatting?.status === "skipped-syntax" ||
      result.warnings.some((warning) => warning.severity === "syntax") ||
      result.hints.some((hint) => hint.source === "compiler" && hint.severity === "error")
    )
      notices.add("Syntax diagnostics detected.");
    if (
      result.data.diffStatuses?.some(
        (status) =>
          status.origin !== "after-edit" &&
          (status.tone === "warning" || status.tone === "error") &&
          (status.formattingStatus === undefined ||
            status.formattingStatus !== result.data.formatting?.status),
      )
    )
      notices.add("Post-edit processing was interrupted or incomplete.");
    for (const status of result.data.diffStatuses ?? [])
      if (status.origin === "after-edit") notices.add(status.text);
  }
  return [...notices];
}

/** Keep the agent's file Write receipt small while retaining full renderer data and targets. */
export function writeAgentResult(
  result: AgentToolResult<FileMutationBatchResult>,
  completions: readonly TextEditCompletion[],
  requestedPath: unknown,
): AgentToolResult<FileMutationBatchResult> {
  // Terminal input and other live resources keep their own action receipts.
  if (
    (typeof requestedPath === "string" && requestedPath.startsWith("shell:")) ||
    completions.some((completion) => completion.resolvedBy !== "filesystem")
  )
    return result;
  const outcome = mutationOutcome(result, "write", completions);
  // Write accepts one file. Completion metadata may also name its absolute alias.
  const source = outcome.data?.files[0]?.source;
  const fallback =
    typeof requestedPath === "string" && !requestedPath.startsWith("<system-result")
      ? requestedPath
      : undefined;
  const status =
    outcome.data?.effect === "applied"
      ? "Saved file."
      : outcome.status === "success" && outcome.data?.effect === "not-applied"
        ? "No write needed."
        : outcome.data?.effect === "unknown"
          ? "Write outcome unknown."
          : "Write failed; no file was written.";
  const reason = outcome.errors[0]?.message.split(/\r?\n/u)[0]?.slice(0, 200);
  const lines = [
    status,
    ...((source ?? fallback) ? [`Path: ${source ?? fallback}`] : []),
    ...(reason ? [`Reason: ${reason}`] : []),
    ...writeProblemNotices(result.details.results ?? []),
    "Read the file if you need its content.",
  ];
  return { ...result, content: [{ type: "text", text: lines.join("\n") }] };
}
