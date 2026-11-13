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
const sourceMatchFields = {
  source: Type.String(),
  target: Type.Optional(Type.String()),
  range: position,
  matchedText: Type.Optional(Type.String()),
  textTruncated: Type.Optional(Type.Boolean()),
  references: Type.Optional(references),
};
const match = Type.Object(
  {
    ...sourceMatchFields,
    captures: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Array(Type.Object(sourceMatchFields, { additionalProperties: false })),
      ),
    ),
    role: Type.Optional(Type.Union([Type.Literal("definition"), Type.Literal("reference")])),
    symbol: Type.Optional(
      Type.Object(
        {
          id: Type.String(),
          name: Type.String(),
          kind: Type.String(),
          /** Selector segments that name the declaration alone in its file. */
          selector: Type.Optional(Type.Array(Type.String())),
          source: Type.String(),
          range: position,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const selectionProperties = {
  target: Type.Optional(Type.String()),
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

/**
 * Project a registered selection in its original order, with every match and its whole text: this
 * data serves scripts, which need all of it. Columns are zero-based UTF-16 offsets.
 */
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
  targets?: { readonly target?: string; readonly matchTargets?: readonly string[] },
) {
  return {
    kind: "matches" as const,
    ...(targets?.target === undefined ? {} : { target: targets.target }),
    complete,
    matches: matches.map((match, index) => ({
      source: match.source,
      ...(targets?.matchTargets?.[index] === undefined
        ? {}
        : { target: targets.matchTargets[index] }),
      range: {
        startLine: match.lineNumber,
        startColumn: match.startColumn,
        endLine: match.endLineNumber ?? match.lineNumber,
        endColumn: match.endColumn,
      },
      matchedText: match.matchedText,
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
