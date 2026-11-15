/** Only a proven whole-line selection can supply an omitted terminal line separator. */
export interface LineSelection {
  content: string;
  from: number;
  to: number;
}

const ending = /(?:\r\n|\n)$/u;
const withoutEnding = (text: string) => text.replace(ending, "");

/** Resolve unique exact text only when both boundaries select complete lines. */
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
 * Normalize only terminal separators whose omission has the same whole-line edit effect.
 * Missing fixture/selection evidence stays strict; final file bytes are checked separately.
 */
export function equivalentLineArguments(
  tool: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  content: string | undefined,
  selected: LineSelection | undefined,
  matches: (expected: unknown, actual: unknown) => boolean,
): Record<string, unknown> {
  const normalized = { ...actual };
  if (content !== undefined) {
    for (const field of ["anchor", "start", "end"]) {
      const selector = actual[field];
      const required = expected[field];
      if (typeof selector !== "string" || required === undefined) continue;
      const span = wholeLineSelection(content, selector);
      if (!span) continue;
      if (typeof required === "string") {
        const other = wholeLineSelection(content, required);
        if (other?.from === span.from && other.to === span.to) normalized[field] = required;
      } else if (ending.test(selector) && matches(required, withoutEnding(selector))) {
        normalized[field] = withoutEnding(selector);
      }
    }
  }
  const required = expected.text;
  const text = actual.text;
  if (
    !selected ||
    typeof required !== "string" ||
    typeof text !== "string" ||
    required === text ||
    withoutEnding(required).length === 0 ||
    withoutEnding(required) !== withoutEnding(text)
  )
    return normalized;
  // Replace preserves the selected line's own separator; Insert adds it before following text.
  const equivalent =
    tool === "replace"
      ? ending.test(selected.content.slice(selected.from, selected.to))
      : tool === "insert" &&
        (actual.before === true ? selected.from : selected.to) < selected.content.length;
  if (equivalent) normalized.text = required;
  return normalized;
}
