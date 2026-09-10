import { Type } from "typebox";

/** Canonical arguments shared by standalone and composed operations. */
export const readParameters = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "What to read: a file or directory path, URL, returned temp: or SEARCH# reference, or one of the source forms listed in the description. Supply a path; an empty call cannot select a source.",
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description:
        "For raw: sources, use a zero-based byte offset; negative offsets count from the file end. For other sources: first line to return, numbered from 1. Omit or use 0 to start at line 1; -1 starts at the last line, -10 at the tenth line from the end. For path#anchor or a SEARCH selection, count from its containing line instead: 0 or 1 starts there, 2 starts one line later, -1 one line earlier.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        "For raw: sources, use a non-negative byte count (0 reads no bytes). Otherwise, maximum lines from the selected starting position. Output is bounded; omit for the default read.",
    }),
  ),
  views: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Optional additions to the returned text. Use the views listed in the tool description. Combine views when needed, for example ["anchors", "ast"] for source text with editable line references and scope boundaries. Omit for the source\'s default presentation.',
    }),
  ),
});
