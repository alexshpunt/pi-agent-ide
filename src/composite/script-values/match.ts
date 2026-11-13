import path from "node:path";

/**
 * The match type that search, ast_search and lsp_search values share. One definition keeps their
 * values compatible and lets each tool's value module change independently.
 */
export interface ScriptMatch {
  /** Path of the matched resource, as `scriptMatchPath` shows it. */
  readonly path: string;
  /** One-based line of the start of the match. */
  readonly line: number;
  /** The whole matched text. */
  readonly text: string;
  /** `RESULT#<uuid>` reference that selects this match. */
  readonly id: string;
}

export const scriptMatchSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    line: { type: "integer" },
    text: { type: "string" },
    id: { type: "string" },
  },
  required: ["path", "line", "text", "id"],
  additionalProperties: false,
} as const;

/**
 * A matched path as a direct call shows it: relative to the session directory `cwd` when it lies
 * inside it, otherwise unchanged, such as an `ssh://` URL or a file outside the workspace.
 */
export function scriptMatchPath(source: string, cwd: string | undefined): string {
  if (cwd === undefined || source.includes("://")) return source;
  const relative = path.relative(cwd, source);
  // oxlint-disable-next-line repo/no-parent-paths -- detects a path outside cwd, not a traversal
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : source;
}
