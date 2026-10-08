import { Type, type TSchema } from "typebox";
import type { ReadRequest } from "#src/api/tools/read.js";

/** Canonical arguments shared by standalone and composed operations. */
export const readParameters = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "What to read: a supported resource such as a file or directory path, URL, returned temp: reference, SEARCH# or RESULT# reference, or registered protocol source. Supply a path; an empty call cannot select a source.",
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

/** Rendered plugin syntax grouped by Read parameter. */
export type ReadParameterText = Partial<Record<keyof ReadRequest, string>>;

// Keep the shared schema's metadata stable for Diff; these descriptions belong to Read.
const coreDescriptions: Record<keyof ReadRequest, string> = {
  path: "Source to read: a resource path, unchanged source result or its UUID. Supply a source; an empty call cannot select one. temp:<id> reads saved output. raw:<local-file> reads original bytes from a regular file; relative, absolute and file:// paths are accepted.",
  offset:
    "For raw: sources, a zero-based integer byte offset; negative offsets count from the file end. For text sources, the first line to return, numbered from 1. Omit or use 0 to start at line 1; -1 starts at the last line, -10 at the tenth line from the end.",
  limit:
    "For raw: sources, a non-negative integer byte count (0 reads no bytes). For text sources, the maximum lines from the selected starting position. Omit for the default read. For other non-text sources, use only a range form described for that source.",
  views:
    "Source-specific presentations. Omit for the source's default presentation. Supply settings after a colon using the syntax below. Combine views only when their contracts allow it. raw: sources do not accept views.",
};

/** Build a fresh Read schema snapshot without changing the shared schema or accepted types. */
export function describeReadParameters(descriptions: ReadParameterText): typeof readParameters {
  const describe = <Schema extends TSchema>(
    schema: Schema,
    parameter: keyof ReadRequest,
  ): Schema => ({
    ...schema,
    description: [coreDescriptions[parameter], descriptions[parameter]]
      .filter((value) => value !== undefined)
      .join("\n"),
  });
  return {
    ...readParameters,
    properties: {
      path: describe(readParameters.properties.path, "path"),
      offset: describe(readParameters.properties.offset, "offset"),
      limit: describe(readParameters.properties.limit, "limit"),
      views: describe(readParameters.properties.views, "views"),
    },
  };
}
