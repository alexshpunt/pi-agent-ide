import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

/** Build a structured source selector without changing legacy path semantics. */
export function resultSourceProperty(description: string) {
  return Type.Optional(Type.Union(resultInputSchema.anyOf, { description }));
}

/** Build the source selector shared by text mutation schemas. */
export function sourcePathProperty(description: string) {
  return Type.Optional(Type.String({ description }));
}

/** Build shared source-range selectors, with optional tool-specific descriptions. */
export function sourceRangeProperties(descriptions: Partial<Record<"start" | "end", string>> = {}) {
  return {
    start: Type.Optional(
      Type.String({
        description:
          descriptions.start ??
          "Anchor or unique exact text where the selection begins. Exact text cuts at its characters; a line anchor takes its whole line. Without end, selects just that fragment. Omit when path is a result that already selects text.",
      }),
    ),
    end: Type.Optional(
      Type.String({
        description:
          descriptions.end ??
          "Anchor or unique exact text where the selection ends, inclusive. Omit when start selects everything.",
      }),
    ),
  };
}

/** Build the destination selectors shared by copy and move schemas. */
export function targetProperties(directorySemantics: string) {
  return {
    target: resultSourceProperty(
      `Destination: a path, or an unchanged result whose ranges are replaced. A whole-file transfer creates missing folders and replaces an existing file. ${directorySemantics}`,
    ),
    targetStart: Type.Optional(
      Type.String({
        description:
          "Anchor or unique exact text in the destination file; the text goes after its line. Required when the text goes into a file path.",
      }),
    ),
    targetEnd: Type.Optional(
      Type.String({
        description:
          "Replace from targetStart through targetEnd instead of inserting after targetStart.",
      }),
    ),
  };
}
