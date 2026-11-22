import { Type } from "typebox";
import { resultInputSchema, resultSourceSchema } from "pi-agent-resource";

/** Build a structured source selector without changing legacy path semantics. */
export function resultSourceProperty(description: string) {
  return Type.Optional(Type.Union(resultInputSchema.anyOf, { description }));
}

/**
 * Build a selector: anchor text, or a value with an id that selects text, such as a Search match
 * in Codemode.
 */
export function anchorProperty(description: string) {
  return Type.Optional(Type.Union(resultSourceSchema.anyOf, { description }));
}

/** Build the shared source selectors; customize what the single selection does. */
export function sourceRangeProperties(at: string) {
  return {
    at: anchorProperty(at),
    from: anchorProperty(
      "Select the unique opening match. Use alone like at, or pair with through or before. Do not combine with after or at.",
    ),
    after: anchorProperty(
      "Begin after the unique opening match (on the next line if it reaches the end of a line). Pass through or before; do not combine with from or at. Use after and before together to select the text between two markers and keep both.",
    ),
    through: anchorProperty(
      "Include the match at or after the start of from (or after the opening match with after); it must match once there, so use its line anchor when the text repeats. Use for a block's own closing line. Pair with from or after; omit before and at.",
    ),
    before: anchorProperty(
      "Stop before the match after the opening match; it must match once there, so use its line anchor when the text repeats. For a whole block, use before only if it has no closing line and ends at the next block's start, such as the next heading. Pair with from or after; omit through and at.",
    ),
  };
}

/** Build the destination selectors shared by copy and move schemas. */
export function targetProperties(directorySemantics: string) {
  return {
    target: resultSourceProperty(
      `Destination path or selection; omit to use the source file. An issued selection without selectors is replaced. A whole-file transfer creates missing folders and replaces an existing file. ${directorySemantics}`,
    ),
    targetAt: anchorProperty(
      "Replace only this selection. Do not combine with other target selectors.",
    ),
    targetFrom: anchorProperty(
      "Select the unique opening match. Use alone like targetAt, or pair with targetThrough or targetBefore.",
    ),
    targetAfter: anchorProperty(
      "Use alone to insert after this selection. Pair with targetThrough or targetBefore to replace a range without including this opening match.",
    ),
    targetThrough: anchorProperty(
      "Include the match at or after the start of targetFrom (or after the opening match with targetAfter); it must match once there, so use its line anchor when the text repeats. Use for a block's own closing line.",
    ),
    targetBefore: anchorProperty(
      "Use alone to insert before this selection. Pair with targetFrom or targetAfter to stop before the match after it, which must match once there; use for a whole block only if it has no closing line and ends at the next block's start.",
    ),
  };
}
