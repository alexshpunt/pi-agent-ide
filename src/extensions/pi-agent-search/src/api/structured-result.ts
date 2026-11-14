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
  lineText: Type.Optional(Type.String()),
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
  editWarning: Type.Optional(Type.String()),
  fallback: Type.Optional(Type.Union([Type.Literal("regex"), Type.Literal("words")])),
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
 * Project a registered selection in its original order, with every match and its whole text, as a
 * script gets it. Search core keeps only a preview for other callers; see `selectionPreview`.
 * Columns are zero-based UTF-16 offsets.
 */
export function selectionData(
  matches: readonly {
    source: string;
    lineNumber: number;
    endLineNumber?: number;
    startColumn: number;
    endColumn: number;
    matchedText: string;
    lineText?: string;
    linesText?: string;
  }[],
  complete: boolean,
  sessionId?: string,
  targets?: { readonly target?: string; readonly matchTargets?: readonly string[] },
) {
  return {
    kind: "matches" as const,
    ...(targets?.target === undefined ? {} : { target: targets.target }),
    complete,
    matches: matches.map((match, index) => {
      const lineText =
        match.linesText ??
        ((match.endLineNumber ?? match.lineNumber) === match.lineNumber
          ? match.lineText
          : undefined);
      return {
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
        ...(lineText === undefined ? {} : { lineText }),
        ...(sessionId === undefined
          ? {}
          : {
              references: {
                line: `SEARCH#${sessionId}:${index + 1}:line`,
                match: `SEARCH#${sessionId}:${index + 1}:match`,
              },
            }),
      };
    }),
    ...(complete && sessionId !== undefined
      ? { all: { line: `SEARCH#${sessionId}:all:line`, match: `SEARCH#${sessionId}:all:match` } }
      : {}),
  };
}

/** Matches a preview keeps, and the longest match text it keeps, in UTF-8 bytes. */
const preview = { matches: 100, textBytes: 4096 } as const;

/**
 * The record of a call that does not hand its result to a script: the first 100 matches, each with
 * its match and line text when each is at most 4 KB. The record of every call must stay within the 1 MiB
 * limit of structured results, which only a script's call lifts. `truncated` marks a shortened
 * list and `textTruncated` an omitted text. A resolver's own value, such as an lsp_search call
 * graph, keeps each list of matches it holds as a preview. Data of other kinds stays as it is.
 */
export function selectionPreview(data: unknown): unknown {
  if (isRecord(data) && data.kind === "custom" && isRecord(data.value))
    return {
      ...data,
      value: Object.fromEntries(
        Object.entries(data.value).map(([key, item]) => [key, selectionPreview(item)]),
      ),
    };
  if (!isRecord(data) || data.kind !== "matches" || !Array.isArray(data.matches)) return data;
  const matches: unknown[] = data.matches;
  return {
    ...data,
    ...(matches.length > preview.matches && { truncated: true }),
    matches: matches.slice(0, preview.matches).map((match) => {
      if (!isRecord(match)) return match;
      const captures = isRecord(match.captures)
        ? Object.fromEntries(
            Object.entries(match.captures).map(([name, nodes]) => [
              name,
              Array.isArray(nodes)
                ? nodes.map((node: unknown) => (isRecord(node) ? previewText(node) : node))
                : nodes,
            ]),
          )
        : undefined;
      return { ...previewText(match), ...(captures !== undefined && { captures }) };
    }),
  };
}

function previewText(match: Record<string, unknown>): Record<string, unknown> {
  const result = { ...match };
  for (const key of ["matchedText", "lineText"]) {
    if (typeof result[key] === "string" && Buffer.byteLength(result[key]) > preview.textBytes) {
      delete result[key];
      result.textTruncated = true;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
