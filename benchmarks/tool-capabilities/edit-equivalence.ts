/** Only a proven whole-line selection can supply an omitted terminal line separator. */
export interface LineSelection {
  content: string;
  from: number;
  to: number;
}

const ending = /(?:\r\n|\n)$/u;
const withoutEnding = (text: string) => text.replace(ending, "");

/**
 * The whole-line extent of a unique line text, such as the line a Read anchor shows. Literal
 * edit selectors never use it: they select only their own characters.
 */
export function wholeLineSelection(content: string, selector: unknown): LineSelection | undefined {
  if (typeof selector !== "string" || selector.length === 0) return undefined;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const exact = selector.replace(/\r\n|\r|\n/gu, eol);
  const from = content.indexOf(exact);
  if (from < 0 || content.indexOf(exact, from + 1) >= 0) return undefined;
  if (from > 0 && content[from - 1] !== "\n") return undefined;
  let to = from + exact.length;
  if (!ending.test(exact)) {
    if (content.startsWith(eol, to)) to += eol.length;
    else if (to !== content.length) return undefined;
  }
  return { content, from, to };
}

/**
 * Normalize only a terminal separator of new text whose omission has the same effect on a line
 * selection, such as a line anchor. Selectors stay strict: a literal selects only its
 * characters, so a terminal newline in it changes the edit. Final file bytes are checked
 * separately.
 */
export function equivalentLineArguments(
  tool: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  selected: LineSelection | undefined,
): Record<string, unknown> {
  const normalized = { ...actual };
  const required = expected.newText;
  const text = actual.newText;
  if (
    !selected ||
    typeof required !== "string" ||
    typeof text !== "string" ||
    required === text ||
    withoutEnding(required).length === 0 ||
    withoutEnding(required) !== withoutEnding(text)
  )
    return normalized;
  // Insert adds the separator before following text. Replace writes exactly its text, so a
  // replacement without the line's separator joins the next line and is not equivalent.
  const equivalent =
    tool === "insert" &&
    (actual.before === true ? selected.from : selected.to) < selected.content.length;
  if (equivalent) normalized.newText = required;
  return normalized;
}
