import { Type, type Static } from "typebox";
import { resultInputSchema, structuredResultSchema } from "pi-agent-resource";

const textOperationSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("range"),
      startLine: Type.Integer({ minimum: 1 }),
      startColumn: Type.Integer({ minimum: 0 }),
      endLine: Type.Integer({ minimum: 1 }),
      endColumn: Type.Integer({ minimum: 0 }),
    },
    {
      additionalProperties: false,
      description:
        "Use absolute one-based lines and exclusive UTF-16 columns in one source. Require full containment in an input region.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("lines"),
      first: Type.Integer({ minimum: 1 }),
      last: Type.Integer({ minimum: 1 }),
    },
    {
      additionalProperties: false,
      description:
        "Use inclusive absolute line numbers in one source. Include existing line endings; require full containment in an input region.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("between"),
      start: Type.String({ minLength: 1 }),
      end: Type.String({ minLength: 1 }),
      extent: Type.Union([Type.Literal("inside"), Type.Literal("around"), Type.Literal("lines")]),
    },
    {
      additionalProperties: false,
      description:
        "Pair non-empty literal opening markers with the next closing marker per region, without nesting. Resume after each pair; unmatched openings are errors. inside excludes markers, around includes them, lines explicitly expands to complete containing lines.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("sliceText"),
      from: Type.Integer({ minimum: 0 }),
      to: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    {
      additionalProperties: false,
      description:
        "Slice each region by non-negative relative UTF-16 offsets. The exclusive to defaults to its end. Equal offsets select a zero-width point.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("trim"),
      side: Type.Union([Type.Literal("start"), Type.Literal("end"), Type.Literal("both")]),
    },
    {
      additionalProperties: false,
      description:
        "Trim Unicode whitespace from the requested edges of each region. A whitespace-only region selects a zero-width point at its end.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("split"),
      delimiter: Type.String({ minLength: 1 }),
    },
    {
      additionalProperties: false,
      description:
        "Split each region by a non-empty literal delimiter, excluding delimiters and retaining empty segments as zero-width points.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("linesOf"),
    },
    {
      additionalProperties: false,
      description:
        "Expand each region to complete containing lines, preserving line endings and reporting expansion. An exclusive end at next-line column zero does not include that next line.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("position"),
      edge: Type.Union([Type.Literal("before"), Type.Literal("after")]),
    },
    {
      additionalProperties: false,
      description:
        "Select the zero-width start or end of each region. Use a whole-file Read for file edges.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("columns"),
      from: Type.Integer({ minimum: 0 }),
      to: Type.Integer({ minimum: 0 }),
    },
    {
      additionalProperties: false,
      description:
        "Select an exclusive UTF-16 column interval on each touched line, excluding line endings. Every interval must fit its line and original input region; no clipping.",
    },
  ),
]);

/** Callable text and structural transformations; future catalog entries are not exposed here. */
export const selectSchema = Type.Object(
  {
    path: {
      ...resultInputSchema,
      description:
        "Pass a compatible source result, its data or RESULT# target, a returned-item array, or a file path. Preview text and reconstructed coordinates are not source targets.",
    },
    operation: Type.Union([
      Type.Object(
        {
          kind: Type.Literal("object"),
          object: Type.Literal("function"),
          relation: Type.Literal("enclosing"),
          level: Type.Literal(1),
          extent: Type.Literal("around"),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("part"),
          part: Type.Literal("body"),
        },
        { additionalProperties: false },
      ),
      textOperationSchema,
    ]),
  },
  { additionalProperties: false },
);

/** Inputs accepted by the Select tool. */
export type SelectParameters = Static<typeof selectSchema>;
/** Supported source transformations. */
export type SelectOperation = SelectParameters["operation"];
/** AST operations require the existing syntax provider. */
export type StructuralSelectOperation = Extract<SelectOperation, { kind: "object" | "part" }>;
/** Text operations work independently of a source language or parser. */
export type TextSelectOperation = Exclude<SelectOperation, StructuralSelectOperation>;

const rangeSchema = Type.Object(
  {
    startLine: Type.Integer({ minimum: 1 }),
    startColumn: Type.Integer({ minimum: 0 }),
    endLine: Type.Integer({ minimum: 1 }),
    endColumn: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Source-backed selection set with bounded previews and retained input associations. */
export const selectionDataSchema = Type.Object(
  {
    kind: Type.Literal("selection"),
    target: Type.String({
      description: "Stored target for every selected range, including items beyond the preview.",
    }),
    complete: Type.Boolean({
      description:
        "Execution completeness inherited from all inputs, independent of preview limits.",
    }),
    totalItems: Type.Integer({ minimum: 0 }),
    missingInputs: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
    items: Type.Array(
      Type.Object(
        {
          target: Type.String(),
          source: Type.String(),
          range: rangeSchema,
          origins: Type.Array(
            Type.Object(
              {
                source: Type.String(),
                range: rangeSchema,
                expanded: Type.Boolean(),
              },
              { additionalProperties: false },
            ),
          ),
          preview: Type.String({ maxLength: 1000 }),
          textTruncated: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);

/** Structured output; editable authority is stored in its targets, not these coordinates. */
export type SelectionData = Static<typeof selectionDataSchema>;
/** One individually consumable selection and the inputs that produced it. */
export type SelectionItem = SelectionData["items"][number];
/** Public structured success/error envelope for Select. */
export const selectOutputSchema = structuredResultSchema(selectionDataSchema);
