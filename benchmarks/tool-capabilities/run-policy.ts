/**
 * The tools a capability attempt starts with. Deferred IDE tools, such as diff, undo, ast_search
 * and lsp_search, stay inactive as in an ordinary session, so routes reach them through
 * tool_search or Codemode. tool_search only searches inactive tools.
 */
export const CAPABILITY_DEFAULT_TOOLS = [
  "read",
  "write",
  "bash",
  "search",
  "replace",
  "insert",
  "delete",
  "copy",
  "move",
  "codemode",
  "tool_search",
] as const;

/** Stop a paid batch after an account failure without reclassifying the failed attempt. */
export function accountStopReason(attempt: {
  status: string;
  reasons: readonly string[];
}): "account-limit" | "authentication" | undefined {
  if (!["model_error", "infra_error", "unavailable"].includes(attempt.status)) return undefined;
  const error = attempt.reasons.join("\n");
  if (
    /billing|credit balance|payment required|extra usage|(?:usage|spend|quota) limit|hit your (?:usage )?limit|insufficient (?:funds|credits)|quota exceeded/iu.test(
      error,
    )
  )
    return "account-limit";
  if (
    /access token expires|expired (?:access )?token|token (?:has )?expired|authentication required|invalid (?:api key|authentication)|unauthorized|please (?:run .*login|log in)/iu.test(
      error,
    )
  )
    return "authentication";
  return undefined;
}
