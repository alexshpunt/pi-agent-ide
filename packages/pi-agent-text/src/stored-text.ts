/** A literal or a UTF-16 slice of the result's already stored text. */
export type StoredText = string | readonly [start: number, length: number];

/** Reuses an exact substring when its reference is smaller than the literal. */
export function storeText(text: string, source: string): StoredText {
  if (text.length < 16) return text;
  const start = source.indexOf(text);
  return start < 0 ? text : [start, text.length];
}

/** Restores text without reading a file or consulting runtime state. */
export function restoreText(text: StoredText, source: string): string {
  return typeof text === "string" ? text : source.slice(text[0], text[0] + text[1]);
}
