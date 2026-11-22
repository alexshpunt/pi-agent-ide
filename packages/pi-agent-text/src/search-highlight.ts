/** Delimiters that Search inserts around a match in its text preview. */
export const SEARCH_HIGHLIGHT_OPEN = "⟦";
export const SEARCH_HIGHLIGHT_CLOSE = "⟧";

/** Removes Search's presentation characters without changing the surrounding text. */
export function stripSearchHighlights(text: string): string {
  return text.replaceAll(SEARCH_HIGHLIGHT_OPEN, "").replaceAll(SEARCH_HIGHLIGHT_CLOSE, "");
}
