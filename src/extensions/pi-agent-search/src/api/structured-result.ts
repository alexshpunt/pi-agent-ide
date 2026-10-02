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
    target: Type.Optional(Type.String()),
    range: position,
    matchedText: Type.Optional(Type.String()),
    textTruncated: Type.Optional(Type.Boolean()),
    references: Type.Optional(references),
  },
  { additionalProperties: false },
);
/** Resolver adapters supply selected domain fields, never renderer details or raw backend objects. */
export const searchDataSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("matches"),
      target: Type.Optional(Type.String()),
      truncated: Type.Optional(Type.Boolean()),
      fullResult: Type.Optional(Type.String()),
      complete: Type.Boolean(),
      matches: Type.Array(match),
      all: Type.Optional(references),
      notices: Type.Optional(Type.Array(Type.String())),
    },
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
  targets?: { readonly target?: string; readonly matchTargets?: readonly string[] },
) {
  return {
    kind: "matches" as const,
    ...(targets?.target === undefined ? {} : { target: targets.target }),
    truncated: matches.length > 100,
    complete,
    matches: matches.slice(0, 100).map((match, index) => ({
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
