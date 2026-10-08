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
        "File, directory, ssh://target/path, HTTP(S) URL, web:ssh://target/https://… or a source-aware result, RESULT# reference or returned target array. Result scopes search only their exact ranges. Use literal or regex: queries for web pages.",
    }),
    navigation: Type.Optional(
      Type.Literal("references", {
        description:
          "Only for symbols: queries. Explicitly follow symbols represented inside path to references outside that scope. Without navigation, returned ranges stay inside path.",
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
