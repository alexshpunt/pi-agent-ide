import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

/** Canonical arguments shared by standalone and composed operations. */
export const searchSchema = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      description:
        "Text to find or a Boolean expression. Quote text to keep it literal. Use regex:<pattern> for regular expressions.",
    }),
    path: Type.Optional(
      Type.Union(resultInputSchema.anyOf, {
        description:
          "File, directory, URL, docs:all for all packaged guide bodies, docs:<id> for one guide, unchanged Read/Search/edit result, its UUID, or an array of such results. Use literal text or regex: for docs: sources. Results select only their registered ranges.",
      }),
    ),
    include: Type.Optional(
      Type.String({ description: "Optional include glob for local or SSH files" }),
    ),
    exclude: Type.Optional(
      Type.String({ description: "Optional exclude glob for local or SSH files" }),
    ),
    caseSensitive: Type.Optional(Type.Boolean({ description: "Match letter case" })),
    wholeWord: Type.Optional(Type.Boolean({ description: "Match complete words" })),
    multiline: Type.Optional(
      Type.Boolean({
        description:
          "Let text or regex:<pattern> match across lines; . also matches line breaks. Local or SSH files and result scopes only.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 1000,
        description: "Maximum displayed items, including compact file summaries (default 50).",
      }),
    ),
  },
  { additionalProperties: false },
);
