const causes: Readonly<Record<string, string>> = {
  LINEAR_INVALID_TEXT_BOUNDARY:
    "The selector splits a character or line ending. Select complete text instead.",
  LINEAR_CONFIRMATION_REQUIRED: "The Linear action was not approved.",
  LINEAR_SNAPSHOT_UNVERIFIED: "Read this body or field before changing it.",
  LINEAR_STALE_CONTENT: "The Linear content changed. Read it again before editing.",
  LINEAR_IDENTITY_OVERRIDE: "The payload tries to change the addressed target.",
  LINEAR_IDENTITY_MISMATCH: "The returned Linear identity does not match the requested target.",
  LINEAR_ANCHOR_NOT_UNIQUE: "The text selector is missing or matches more than once.",
  LINEAR_ANCHOR_STALE: "The line anchor no longer matches. Read the body again.",
  LINEAR_OPERATION_CANCELLED: "The Linear operation was canceled.",
};
/** Remote text stays exact for the agent, but never controls the human's terminal. */
export function safeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
}
export function standalonePresentation(
  text: string,
  details: unknown,
  isError: boolean,
  expanded: boolean,
): string {
  if (isError) {
    const data = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
    const code = typeof data.code === "string" ? data.code : /LINEAR_[A-Z_]+/u.exec(text)?.[0];
    return [
      causes[code ?? ""] ?? "Linear could not complete this operation.",
      data.effect === "unknown"
        ? "Delivery is uncertain. Inspect the target before retrying."
        : data.effect === "applied"
          ? "The change was saved. Read the target to inspect its current state."
          : "No change was made.",
      ...(typeof data.source === "string" ? [safeTerminalText(data.source)] : []),
    ].join("\n");
  }
  const lines = safeTerminalText(text).split("\n");
  return (
    (expanded ? lines : lines.slice(0, 8)).join("\n") +
    (!expanded && lines.length > 8 ? "\n… Expand to see the full result." : "")
  );
}
