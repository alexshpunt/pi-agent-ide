import { Type } from "typebox";
import { resultInputSchema, resultSourceSchema } from "pi-agent-resource";

/** Build a structured source selector without changing legacy path semantics. */
export function resultSourceProperty(description: string) {
  return Type.Optional(Type.Union(resultInputSchema.anyOf, { description }));
}

/** Build the source selector shared by text mutation schemas. */
export function sourcePathProperty(description: string) {
  return Type.Optional(Type.String({ description }));
}

/**
 * Build a selector: anchor text, or a value with an id that selects text, such as a Search match
 * in Codemode.
 */
export function anchorProperty(description: string) {
  return Type.Optional(Type.Union(resultSourceSchema.anyOf, { description }));
}

/** Build shared source-range selectors, with optional tool-specific descriptions. */
export function sourceRangeProperties(descriptions: Partial<Record<"start" | "end", string>> = {}) {
  return {
    start: anchorProperty(
      descriptions.start ??
        "Start selector; omit when path selects the intended text. With a result as path, it selects inside the result's ranges.",
    ),
    end: anchorProperty(descriptions.end ?? "Inclusive end selector; omit for start alone."),
  };
}

/** Build the destination selectors shared by copy and move schemas. */
export function targetProperties(directorySemantics: string) {
  return {
    target: resultSourceProperty(
      `Destination: a path, or an unchanged result whose ranges are replaced. A whole-file transfer creates missing folders and replaces an existing file. ${directorySemantics}`,
    ),
    targetStart: anchorProperty(
      "Anchor or unique exact text in the destination file; the text goes after its selected extent. Required when the text goes into a file path.",
    ),
    targetEnd: anchorProperty(
      "Replace from targetStart through targetEnd instead of inserting after targetStart.",
    ),
  };
}
