/**
 * The match type that search, ast_search and lsp_search values share. One definition keeps their
 * values compatible and lets each tool's value module change independently.
 */
export interface ScriptMatch {
  /** Path of the matched resource. */
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
