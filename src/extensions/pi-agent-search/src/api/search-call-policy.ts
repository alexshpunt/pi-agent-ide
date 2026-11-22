/** Resolve script-call policy without changing the meaning of each resolver's limit. */
export function searchCallPolicy(
  limit: number | undefined,
  script: boolean,
  kind: "matches" | "presentation" | "files",
): {
  limit: number | undefined;
  audience: "agent" | "script";
  uncappedFiles: boolean;
} {
  return {
    limit: limit ?? (script && kind === "matches" ? Number.MAX_SAFE_INTEGER : undefined),
    audience: script ? "script" : "agent",
    uncappedFiles: script && kind === "files",
  };
}
