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
          "Anchor or unique exact text. Alone, selects that fragment; a line anchor selects its line. With end, starts at this selector's beginning: exact text and SEARCH :match keep character boundaries; line anchors and SEARCH :line keep whole lines. Omit when path already selects text through a supported resource reference.",
      }),
    ),
    end: Type.Optional(
      Type.String({
        description:
          descriptions.end ??
          "Optional anchor or unique exact text. Ends after this selector: exact text and SEARCH :match include the ending match without widening to lines; line anchors and SEARCH :line include their whole line. Mixed endpoint types keep their own extents. Boundaries must be unique, in one file, and forward-ordered. Omit when start already selects the intended content; do not repeat start.",
      }),
    ),
  };
}

/** Build the destination selectors shared by copy and move schemas. */
export function targetProperties(directorySemantics: string) {
  return {
    target: resultSourceProperty(
      `Destination path, unchanged source result or its UUID. A result replaces its exact ranges (zero-width ranges insert); omit targetStart/targetEnd. Source and destination selections pair in declared order with equal counts. A path with text selectors keeps its existing anchor semantics. Whole-object transfers create missing parents and replace regular destination files. ${directorySemantics} Reject symlink destinations, type conflicts, and overlapping directory trees.`,
    ),
    targetStart: Type.Optional(
      Type.String({
        description:
          "Registered anchor or unique exact text in the destination. Required for text transfers to a file path; omit for whole-file transfers or a result destination. Without targetEnd, inserts after the last containing line, keeping the selected text. With targetEnd, starts replacement at this selector's beginning: exact text and SEARCH :match keep character boundaries; line anchors and SEARCH :line keep whole lines.",
      }),
    ),
    targetEnd: Type.Optional(
      Type.String({
        description:
          "Optional destination end. Ends replacement after the exact text or SEARCH :match, or after the whole line for line anchors and SEARCH :line. Mixed endpoint types keep their own extents. Both boundaries must resolve uniquely in the target file and in forward order. Omit to insert after targetStart instead.",
      }),
    ),
  };
}
