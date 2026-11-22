import { Type, type Static, type TSchema } from "typebox";
import { resultSourceSchema } from "pi-agent-resource";
import type { ReadRequest } from "#src/api/tools/read.ts";

const sourceDescription = "File or resource address, or an unchanged result or its id.";
const toolSourceDescription = `${sourceDescription} An array reads each source separately, in order.`;

/** Canonical arguments shared by standalone and composed operations. */
export const readParameters = Type.Object({
  // The IDE resolves a value's id to its source before Read runs; `readRequestOf` covers other callers.
  path: Type.Optional(
    Type.Union(resultSourceSchema.anyOf, {
      description: sourceDescription,
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description:
        "For raw: sources, use a zero-based byte offset; negative offsets count from the file end. For other sources: first line to return, numbered from 1. Omit or use 0 to start at line 1; -1 starts at the last line, -10 at the tenth line from the end. For path#anchor, SEARCH or RESULT# selections, count from its containing line instead: 0 or 1 starts there, 2 starts one line later, -1 one line earlier. For image and sequence views, offset is a zero-based row-major grid cell index and requires limit.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        "For raw: sources, use a non-negative byte count (0 reads no bytes). Otherwise, maximum lines from the selected starting position. Output is bounded; omit for the default read. For image and sequence views, limit is the square grid cell size in pixels; omit offset to select cell 0, or omit both for the bounded full image.",
    }),
  ),
  views: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Optional source-specific presentations. Combine views when both presentations are needed, for example ["anchors", "ast"]. Omit for the source\'s default presentation.',
    }),
  ),
});

/** Read arguments as declared: `path` can be a script value with an id. */
export type ReadParameters = Static<typeof readParameters>;

/** A Read request whose script-value path is replaced by its id, which Read resolves itself. */
export function readRequestOf(parameters: ReadParameters): ReadRequest {
  const { path, ...rest } = parameters;
  if (path === undefined) return rest;
  return { ...rest, path: typeof path === "string" ? path : path.id };
}

/**
 * The Read tool's own arguments: `path` can also list several sources, each read on its
 * own. Composed operations, such as each side of Diff, keep one source.
 */
export const readToolParameters = Type.Object({
  ...readParameters.properties,
  path: Type.Optional(
    Type.Union([...resultSourceSchema.anyOf, Type.Array(resultSourceSchema, { minItems: 1 })], {
      description: toolSourceDescription,
    }),
  ),
});

export type ReadToolParameters = Static<typeof readToolParameters>;

/** One Read request per path of a Read tool call, in order. */
export function readRequestsOf(parameters: ReadToolParameters): ReadRequest[] {
  const { path, ...rest } = parameters;
  if (!Array.isArray(path)) return [readRequestOf(path === undefined ? rest : { ...rest, path })];
  return path.map((source) => readRequestOf({ ...rest, path: source }));
}

/** Rendered plugin syntax grouped by Read parameter. */
export type ReadParameterText = Partial<Record<keyof ReadRequest, string>>;

// Keep the shared schema's metadata stable for Diff; these descriptions belong to Read.
const coreDescriptions: Record<keyof ReadRequest, string> = {
  path: toolSourceDescription,
  offset: "First line, from 1; negative counts from the end. For raw:, a byte offset.",
  limit: "Maximum lines. For raw:, bytes.",
  views: "Extra presentations; combine them unless a view says otherwise.",
};

/** Build a fresh Read schema snapshot without changing the shared schema or accepted types. */
export function describeReadParameters(descriptions: ReadParameterText): typeof readToolParameters {
  const describe = <Schema extends TSchema>(
    schema: Schema,
    parameter: keyof ReadRequest,
  ): Schema => ({
    ...schema,
    description: [
      coreDescriptions[parameter],
      parameter === "path" ? undefined : descriptions[parameter],
    ]
      .filter((value) => value !== undefined)
      .join("\n"),
  });
  return {
    ...readToolParameters,
    properties: {
      path: describe(readToolParameters.properties.path, "path"),
      offset: describe(readToolParameters.properties.offset, "offset"),
      limit: describe(readToolParameters.properties.limit, "limit"),
      views: describe(readToolParameters.properties.views, "views"),
    },
  };
}
