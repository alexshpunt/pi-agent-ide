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
  /**
   * `RESULT#<uuid>` reference that selects this match. Absent when the source has no selections,
   * such as terminal output or a guide.
   */
  readonly id?: string;
}

export const scriptMatchSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    line: { type: "integer" },
    text: { type: "string" },
    id: {
      type: "string",
      description: "Selects this match. Absent when the source has no selections.",
    },
  },
  required: ["path", "line", "text"],
  additionalProperties: false,
} as const;

/**
 * A matched path as a direct call shows it: a local file inside the session directory `cwd`
 * relative to it, any other source unchanged, such as an `ssh://` URL, a `shell:` session or a file
 * outside the workspace.
 */
export function scriptMatchPath(source: string, cwd: string | undefined): string {
  if (cwd === undefined || !path.isAbsolute(source)) return source;
  const relative = path.relative(cwd, source);
  // oxlint-disable-next-line repo/no-parent-paths -- detects a path outside cwd, not a traversal
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : source;
}
