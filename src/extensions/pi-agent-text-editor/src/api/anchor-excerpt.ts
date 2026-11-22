export const MAX_ANCHOR_EXCERPT_LENGTH = 160;

/** Quote only a bounded excerpt; never serialize a full oversized selector. */
export function quoteAnchorExcerpt(value: string): string {
  if (value.length <= MAX_ANCHOR_EXCERPT_LENGTH) return JSON.stringify(value);
  return `${JSON.stringify(value.slice(0, 56))} … ${JSON.stringify(value.slice(-56))} (${value.length} UTF-16 code units in all)`;
}
