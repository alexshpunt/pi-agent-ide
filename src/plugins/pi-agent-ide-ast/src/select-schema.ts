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

function scopedOperation<const Kind extends "within" | "intersection" | "difference">(
  kind: Kind,
  description: string,
) {
  return Type.Object(
    {
      kind: Type.Literal(kind),
      scopes: {
        ...resultInputSchema,
        description:
          "Comparison scopes: unchanged results, issued UUIDs or item references, arrays of those strings, or a readable source path. Match sets by source, not array position.",
      },
    },
    { additionalProperties: false, description },
  );
}

const geometryOperationSchema = Type.Union([
  scopedOperation(
    "within",
    "Retain each candidate whole only when one comparison scope contains it. Never clip or join scopes for containment.",
  ),
  scopedOperation(
    "intersection",
    "Clip each candidate to the union of comparison scopes in its source. Touching text ranges do not create a point.",
  ),
  scopedOperation(
    "difference",
    "Subtract comparison scopes from each candidate, retaining separate surviving fragments. Point scopes do not cut text.",
  ),
  Type.Object(
    {
      kind: Type.Literal("merge"),
      adjacent: Type.Optional(
        Type.Boolean({
          description:
            "Also merge touching nonempty ranges. Default false; never fill a gap or extend text for a point.",
        }),
      ),
    },
    {
      additionalProperties: false,
      description:
        "Explicitly merge overlapping ranges by source, retaining every contributing origin. Covered points are absorbed; other points remain separate.",
    },
  ),
]);

const astObjectSchema = Type.Union([
  Type.Literal("function"),
  Type.Literal("call"),
  Type.Literal("class"),
  Type.Literal("if"),
  Type.Literal("switch"),
  Type.Literal("loop"),
  Type.Literal("try"),
  Type.Literal("catch"),
  Type.Literal("binding"),
  Type.Literal("assignment"),
  Type.Literal("object"),
  Type.Literal("property"),
  Type.Literal("array"),
  Type.Literal("return"),
  Type.Literal("throw"),
]);
const astPartSchema = Type.Union([
  Type.Literal("name"),
  Type.Literal("body"),
  Type.Literal("parameters"),
  Type.Literal("returnType"),
  Type.Literal("type"),
  Type.Literal("callee"),
  Type.Literal("arguments"),
  Type.Literal("condition"),
  Type.Literal("then"),
  Type.Literal("else"),
  Type.Literal("initializer"),
  Type.Literal("update"),
  Type.Literal("iterable"),
  Type.Literal("left"),
  Type.Literal("right"),
  Type.Literal("value"),
  Type.Literal("key"),
  Type.Literal("handler"),
  Type.Literal("finalizer"),
  Type.Literal("parameter"),
]);
const objectFilter = Type.Optional({
  ...astObjectSchema,
  description:
    "Filter results by construct category after navigation. The filter does not change parent/child/sibling relationships.",
});
const structuralOperationSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("elementExtent"),
      extent: Type.Union([Type.Literal("inside"), Type.Literal("around")]),
    },
    {
      additionalProperties: false,
      description:
        "Select an exact direct JS/TS call argument or parenthesized function parameter. inside keeps the element; around includes owned comma/whitespace. Prefer the following separator; last without a trailing comma uses the preceding gap; only elements own the list interior. Adjacent boundary comments reject around. No destination syntax repair.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("object"),
      object: astObjectSchema,
      relation: Type.Optional(Type.Literal("enclosing")),
      level: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Default 1 (nearest). Count only constructs of the requested category.",
        }),
      ),
      extent: Type.Optional(Type.Literal("around")),
    },
    {
      additionalProperties: false,
      description:
        "Select the requested containing construct. level=1 is nearest and includes an exact seed; higher levels count only that category. Match the entire seed, not its first character.",
    },
  ),
  Type.Object(
    { kind: Type.Literal("part"), part: astPartSchema },
    {
      additionalProperties: false,
      description:
        "Select an exact supported construct's named part, including delimiters belonging to its syntax node. A supported optional part may be absent; unsupported parts are errors with available names. Use an enclosing object first for partial input.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("navigate"),
      relation: Type.Union([
        Type.Literal("parent"),
        Type.Literal("ancestors"),
        Type.Literal("children"),
        Type.Literal("descendants"),
      ]),
      object: objectFilter,
    },
    {
      additionalProperties: false,
      description:
        "Navigate from an exact named syntax node, including constructs, part targets and the document root. Skip parser-only wrappers in results. Exclude the starting node; ancestors/descendants return results in source order. parent/children never skip recognized constructs to satisfy a filter. Use enclosing first for ranges that cut through a node.",
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("navigate"),
      relation: Type.Literal("siblings"),
      object: objectFilter,
      direction: Type.Optional(
        Type.Union([Type.Literal("previous"), Type.Literal("next"), Type.Literal("all")], {
          description:
            "Default all. previous/next select the immediate sibling before category filtering, not the next matching category.",
        }),
      ),
    },
    {
      additionalProperties: false,
      description:
        "Select siblings of an exact supported construct under the same normalized parent. Exclude the input; return source order. A missing neighbor is valid absence.",
    },
  ),
]);
/** Normalized JS/TS constructs, independent of parser-only wrapper nodes. */
export type AstObject = Static<typeof astObjectSchema>;
/** Named construct parts. Availability depends on the actual node form. */
export type AstPart = Static<typeof astPartSchema>;
/** Callable text and structural transformations; future catalog entries are not exposed here. */
export const selectSchema = Type.Object(
  {
    path: {
      ...resultInputSchema,
      description:
        "File path, unchanged Read/Search/Select/edit result, its UUID, or an array of such results. Pass the whole result; do not rebuild it from preview text.",
    },
    operation: Type.Union([
      structuralOperationSchema,
      textOperationSchema,
      geometryOperationSchema,
    ]),
  },
  { additionalProperties: false },
);

/** Inputs accepted by the Select tool. */
export type SelectParameters = Static<typeof selectSchema>;
/** Supported source transformations. */
export type SelectOperation = SelectParameters["operation"];
/** AST operations require the existing syntax provider. */
export type StructuralSelectOperation = Static<typeof structuralOperationSchema>;
/** Geometry operations compare verified source-local sets. */
export type GeometrySelectOperation = Static<typeof geometryOperationSchema>;
/** Text operations work independently of a source language or parser. */
export type TextSelectOperation = Exclude<
  SelectOperation,
  StructuralSelectOperation | GeometrySelectOperation
>;

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
          syntax: Type.Optional(
            Type.Object(
              {
                object: astObjectSchema,
                part: Type.Optional(astPartSchema),
              },
              {
                additionalProperties: false,
                description:
                  "Parser-derived normalized construct category and selected part. This describes the target; it is not edit authority.",
              },
            ),
          ),
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
