import { Type, type Static } from "typebox";
import { resultInputSchema, structuredResultSchema } from "pi-agent-resource";

/** Callable structural operations; future catalog entries are not exposed here. */
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
    ]),
  },
  { additionalProperties: false },
);

/** Inputs accepted by the Select tool. */
export type SelectParameters = Static<typeof selectSchema>;
/** The two structural transformations supported in this stage. */
export type SelectOperation = SelectParameters["operation"];

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
