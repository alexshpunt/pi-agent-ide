import { Type } from "typebox";
import { structuredResultSchema } from "pi-agent-resource";

const position = Type.Object(
  {
    startLine: Type.Integer(),
    startColumn: Type.Integer(),
    endLine: Type.Integer(),
    endColumn: Type.Integer(),
  },
  { additionalProperties: false },
);
const references = Type.Object(
  { line: Type.Optional(Type.String()), match: Type.Optional(Type.String()) },
  { additionalProperties: false },
);
const match = Type.Object(
  {
    source: Type.String(),
    range: position,
    matchedText: Type.Optional(Type.String()),
    textTruncated: Type.Optional(Type.Boolean()),
    references: Type.Optional(references),
  },
  { additionalProperties: false },
);
const selectionProperties = {
  kind: Type.Literal("matches"),
  truncated: Type.Optional(Type.Boolean()),
  fullResult: Type.Optional(Type.String()),
  complete: Type.Boolean(),
  matches: Type.Array(match),
  all: Type.Optional(references),
  notices: Type.Optional(Type.Array(Type.String())),
};
/** Separate possible-name groups with exact captured ranges and optional Read references. */
export const fuzzyDataSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ready"), Type.Literal("skipped")]),
    message: Type.Optional(Type.String()),
    candidates: Type.Array(
      Type.Object(
        {
          identifier: Type.String(),
          kind: Type.Union([
            Type.Literal("normalized"),
            Type.Literal("component"),
            Type.Literal("typo"),
          ]),
          reason: Type.String(),
          matchCount: Type.Integer(),
          fileCount: Type.Integer(),
          selection: Type.Object(selectionProperties, { additionalProperties: false }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
/** Resolver adapters supply selected domain fields, never renderer details or raw backend objects. */
export const searchDataSchema = Type.Union([
  Type.Object(
    { ...selectionProperties, fuzzy: Type.Optional(fuzzyDataSchema) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("files"), complete: Type.Boolean(), files: Type.Array(Type.String()) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("custom"), resolverId: Type.String(), value: Type.Unknown() },
    { additionalProperties: false },
  ),
]);
export const searchOutputSchema = structuredResultSchema(searchDataSchema);

/** Project a registered selection in its original order. Columns are zero-based UTF-16 offsets. */
export function selectionData(
  matches: readonly {
    source: string;
    lineNumber: number;
    endLineNumber?: number;
    startColumn: number;
    endColumn: number;
    matchedText: string;
  }[],
  complete: boolean,
  sessionId?: string,
) {
  return {
    kind: "matches" as const,
    truncated: matches.length > 100,
    complete,
    matches: matches.slice(0, 100).map((match, index) => ({
      source: match.source,
      range: {
        startLine: match.lineNumber,
        startColumn: match.startColumn,
        endLine: match.endLineNumber ?? match.lineNumber,
        endColumn: match.endColumn,
      },
      ...(Buffer.byteLength(match.matchedText) <= 4096
        ? { matchedText: match.matchedText }
        : { textTruncated: true }),
      ...(sessionId === undefined
        ? {}
        : {
            references: {
              line: `SEARCH#${sessionId}:${index + 1}:line`,
              match: `SEARCH#${sessionId}:${index + 1}:match`,
            },
          }),
    })),
    ...(complete && sessionId !== undefined
      ? { all: { line: `SEARCH#${sessionId}:all:line`, match: `SEARCH#${sessionId}:all:match` } }
      : {}),
  };
}
