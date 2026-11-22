/** Only a proven whole-line selection can supply an omitted terminal line separator. */
export interface LineSelection {
  content: string;
  from: number;
  to: number;
}

const ending = /(?:\r\n|\n)$/u;

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
 * Accept a single separator on either edge of an Insert payload if the destination
 * supplies its final separator. Omitting every break leaves the payload inline.
 * Final file bytes are checked separately.
 */
export function equivalentLineArguments(
  tool: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  selected: LineSelection | undefined,
): Record<string, unknown> {
  const required = expected.text;
  const text = actual.text;
  if (tool !== "insert" || !selected || typeof required !== "string" || typeof text !== "string")
    return actual;

  const trailing = /^([^\r\n]+)\r?\n$/u;
  const leading = /^\r?\n([^\r\n]+)$/u;
  const body = (value: string) => (trailing.exec(value) ?? leading.exec(value))?.[1];
  const requiredBody = body(required);
  if (required === text || requiredBody === undefined || requiredBody !== body(text)) return actual;

  return { ...actual, text: required };
}
