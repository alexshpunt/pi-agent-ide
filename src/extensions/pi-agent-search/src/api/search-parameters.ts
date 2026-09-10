import { Type } from "typebox";

/** Canonical arguments shared by standalone and composed operations. */
export const searchSchema = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      description:
        "Text to find, a Boolean expression, or a prefixed query described below, such as files:*.ts. Quote text to keep it literal, or use regex:<pattern> for regular-expression matching.",
    }),
    path: Type.Optional(
      Type.String({ description: "Optional file or directory scope for local search" }),
    ),
    include: Type.Optional(Type.String({ description: "Optional include glob for local search" })),
    exclude: Type.Optional(Type.String({ description: "Optional exclude glob for local search" })),
    caseSensitive: Type.Optional(
      Type.Boolean({ description: "Match letter case in local search" }),
    ),
    wholeWord: Type.Optional(Type.Boolean({ description: "Match complete words in local search" })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum results (default 100)" }),
    ),
  },
  { additionalProperties: false },
);
