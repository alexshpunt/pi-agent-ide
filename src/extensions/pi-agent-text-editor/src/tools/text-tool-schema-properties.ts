import { Type } from "typebox";

/** Build the source selector shared by text mutation schemas. */
export function sourcePathProperty(description: string) {
  return Type.Optional(Type.String({ description }));
}

/** Build the inclusive source-range selectors shared by text mutation schemas. */
export function sourceRangeProperties() {
  return {
    start: Type.Optional(
      Type.String({
        description:
          "Anchor or unique exact text. Alone, selects that fragment; a line anchor selects only its line. Omit when path already selects text through a supported resource reference. With end, selects a whole-line range.",
      }),
    ),
    end: Type.Optional(
      Type.String({
        description:
          "Optional anchor or unique exact text. Range includes start's first line through end's last line, even for SEARCH :match. Mixed types allowed; boundaries must be unique, in one file, and forward-ordered. Omit when start already selects the intended content; do not repeat start. The end line is included, not a stopping point before it.",
      }),
    ),
  };
}

/** Build the destination selectors shared by copy and move schemas. */
export function targetProperties() {
  return {
    target: Type.Optional(
      Type.String({
        description:
          "Target resource reference or file path. Required for a whole-file operation; defaults to the source for selected text.",
      }),
    ),
    targetStart: Type.Optional(
      Type.String({
        description:
          "Registered anchor or unique exact text in the destination. Required unless target already selects one destination range. Without targetEnd, inserts after the last containing line, keeping the selected text. With targetEnd, replacement starts at the first containing line. SEARCH :match also uses these line boundaries.",
      }),
    ),
    targetEnd: Type.Optional(
      Type.String({
        description:
          "Optional inclusive destination end. Replaces whole lines through the last line containing this anchor, including SEARCH :match. May differ in type from targetStart; both must resolve uniquely in the target file and in forward order. Omit to insert after targetStart instead.",
      }),
    ),
    overwrite: Type.Optional(
      Type.Boolean({
        description: "Allow replacing an existing regular target file. Defaults to false.",
      }),
    ),
  };
}
