import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

/** Canonical arguments shared by standalone and composed operations. */
export const searchSchema = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      description:
        "Text to find, a Boolean expression, or a prefixed query described below, such as files:*.ts. Quote text to keep it literal, or use regex:<pattern> for regular-expression matching.",
    }),
    path: Type.Optional({
      ...resultInputSchema,
      description:
        "File, directory, URL, unchanged Read/Search/Select/edit result, its UUID, or an array of such results. Results select only their registered ranges unless symbols: navigation follows external references.",
    }),
    navigation: Type.Optional(
      Type.Literal("references", {
        description:
          "Only for symbols: queries. Explicitly follow symbols represented inside path to their references outside that scope. Without navigation, all returned ranges stay inside path.",
      }),
    ),
    include: Type.Optional(Type.String({ description: "Optional include glob for local search" })),
    exclude: Type.Optional(Type.String({ description: "Optional exclude glob for local search" })),
    caseSensitive: Type.Optional(Type.Boolean({ description: "Match letter case" })),
    wholeWord: Type.Optional(Type.Boolean({ description: "Match complete words" })),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 1000,
        description: "Maximum detailed results returned to the agent (default 50)",
      }),
    ),
  },
  { additionalProperties: false },
);
