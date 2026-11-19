import {
  normalizeForFuzzyMatch,
  normalizeToLF,
  splitBom,
} from "pi-agent-text-editor/api/pi-edit-text";

/** A span of the file in source offsets: `content.slice(from, to)`. */
export interface LiteralSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * One way to find literal text in a file. Matchers run from strict to tolerant; the first one
 * that finds the literal decides, so an exact match always wins over a tolerant one.
 */
export interface LiteralMatcher {
  readonly id: string;
  /** Up to `limit` accepted spans in file order. Each span covers whole source characters. */
  find(
    content: string,
    value: string,
    accept: (span: LiteralSpan) => boolean,
    limit: number,
  ): LiteralSpan[];
}

/**
 * The literal's exact characters. As in Pi's edit, a span never splits a CRLF: one that starts
 * at its LF or ends after its CR covers the whole CRLF.
 */
const exactMatcher: LiteralMatcher = {
  id: "exact",
  find(content, value, accept, limit) {
    return scan(
      content,
      value,
      (start) => {
        const end = start + value.length;
        return {
          from: content[start] === "\n" && content[start - 1] === "\r" ? start - 1 : start,
          to: content[end - 1] === "\r" && content[end] === "\n" ? end + 1 : end,
        };
      },
      accept,
      limit,
    );
  },
};

/**
 * Pi's edit matching: the BOM is ignored, and CRLF and lone CR match LF. A span that covers
 * the LF of a CRLF covers the whole CRLF.
 */
const lineEndingMatcher: LiteralMatcher = {
  id: "line-endings",
  find(content, value, accept, limit) {
    const { bom, text } = splitBom(content);
    const query = normalizeToLF(splitBom(value).text);
    const normalized = normalizeToLF(text);
    // Without anything to normalize this is the exact matcher again.
    if (query.length === 0 || (bom === "" && normalized === text && query === value)) return [];
    const toSource = sourceOffsets(text, bom.length);
    return scan(
      normalized,
      query,
      (start) => ({ from: toSource(start), to: toSource(start + query.length) }),
      accept,
      limit,
    );
  },
};

/**
 * Pi's fuzzy matching on top of the line-ending matcher: Unicode compatibility forms, trailing
 * whitespace of each line, smart quotes, dashes and special spaces are ignored. The span covers
 * only the source characters the match came from. A match that would cut a character Pi expands
 * into several, such as a ligature, is not a match.
 */
const fuzzyMatcher: LiteralMatcher = {
  id: "fuzzy",
  find(content, value, accept, limit) {
    const query = normalizeForFuzzyMatch(normalizeToLF(splitBom(value).text));
    if (query.length === 0) return [];
    const { bom, text } = splitBom(content);
    const fuzzy = fuzzyText(normalizeToLF(text));
    if (fuzzy === undefined) return [];
    const toSource = sourceOffsets(text, bom.length);
    const { starts, ends } = fuzzy;
    return scan(
      fuzzy.text,
      query,
      (start) => {
        const end = start + query.length;
        const from = starts[start] ?? 0;
        const to = ends[end - 1] ?? 0;
        const cutsStart = start > 0 && starts[start - 1] === from;
        const cutsEnd = end < starts.length && starts[end] === starts[end - 1];
        return cutsStart || cutsEnd ? undefined : { from: toSource(from), to: toSource(to) };
      },
      accept,
      limit,
    );
  },
};

/** Literal matchers from strict to tolerant. */
export const LITERAL_MATCHERS: readonly LiteralMatcher[] = [
  exactMatcher,
  lineEndingMatcher,
  fuzzyMatcher,
];

export type LiteralMatch =
  | { readonly kind: "unique"; readonly span: LiteralSpan; readonly matcher: string }
  | { readonly kind: "ambiguous"; readonly matcher: string }
  | { readonly kind: "missing" };

/** Finds the one span the literal selects: the first matcher that finds it decides. */
export function matchLiteral(
  content: string,
  value: string,
  accept: (span: LiteralSpan) => boolean = () => true,
): LiteralMatch {
  if (value.length === 0) return { kind: "missing" };
  for (const matcher of LITERAL_MATCHERS) {
    const [first, second] = matcher.find(content, value, accept, 2);
    if (second !== undefined) return { kind: "ambiguous", matcher: matcher.id };
    if (first !== undefined) return { kind: "unique", span: first, matcher: matcher.id };
  }
  return { kind: "missing" };
}

/** Every span of the first matcher that finds the literal, up to `limit`, and their number. */
export function literalCandidates(
  content: string,
  value: string,
  limit: number,
): { readonly spans: readonly LiteralSpan[]; readonly total: number } {
  if (value.length === 0) return { spans: [], total: 0 };
  for (const matcher of LITERAL_MATCHERS) {
    const spans = matcher.find(content, value, () => true, Number.MAX_SAFE_INTEGER);
    if (spans.length > 0) return { spans: spans.slice(0, limit), total: spans.length };
  }
  return { spans: [], total: 0 };
}

/** Overlapping occurrences of `query` in `text`, mapped to source spans and filtered. */
function scan(
  text: string,
  query: string,
  span: (start: number) => LiteralSpan | undefined,
  accept: (span: LiteralSpan) => boolean,
  limit: number,
): LiteralSpan[] {
  const spans: LiteralSpan[] = [];
  if (query.length === 0) return spans;
  for (
    let start = text.indexOf(query);
    start !== -1 && spans.length < limit;
    start = text.indexOf(query, start + 1)
  ) {
    const mapped = span(start);
    if (mapped !== undefined && accept(mapped)) spans.push(mapped);
  }
  return spans;
}

/**
 * Maps an offset in `normalizeToLF(text)` to the source, as Pi's `applyReplacementsToOriginal`
 * does: each CRLF before the offset adds one character, so an offset at the LF of a CRLF maps
 * to its CR. `base` is the length of a BOM before `text`.
 */
function sourceOffsets(text: string, base: number): (offset: number) => number {
  // Normalized positions of the LF of each CRLF.
  const lineFeeds: number[] = [];
  for (let crlf = text.indexOf("\r\n"); crlf !== -1; crlf = text.indexOf("\r\n", crlf + 2))
    lineFeeds.push(crlf - lineFeeds.length);
  return (offset) => {
    let low = 0;
    let high = lineFeeds.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((lineFeeds[middle] ?? Infinity) < offset) low = middle + 1;
      else high = middle;
    }
    return base + offset + low;
  };
}

/**
 * `normalizeForFuzzyMatch(text)` with the range of `text` each of its code units came from.
 * Text is normalized one character at a time, a character being a code point with the marks
 * that can compose with it. Returns undefined when that differs from normalizing the whole
 * text, so a fuzzy match never maps to the wrong source.
 */
function fuzzyText(
  text: string,
): { readonly text: string; readonly starts: number[]; readonly ends: number[] } | undefined {
  const units: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let lineStart = 0;
  for (;;) {
    const lineFeed = text.indexOf("\n", lineStart);
    const lineEnd = lineFeed === -1 ? text.length : lineFeed;
    const lineUnits = units.length;
    let from = lineStart;
    while (from < lineEnd) {
      let to = from + codePointLength(text, from);
      while (to < lineEnd && !startsCharacter(text, to)) to += codePointLength(text, to);
      const normalized = text.slice(from, to).normalize("NFKC");
      for (const unit of normalized.split("")) {
        units.push(unit);
        starts.push(from);
        ends.push(to);
      }
      from = to;
    }
    // Pi strips trailing whitespace from each line.
    const kept = lineUnits + units.slice(lineUnits).join("").trimEnd().length;
    units.length = kept;
    starts.length = kept;
    ends.length = kept;
    if (lineFeed === -1) break;
    units.push("\n");
    starts.push(lineFeed);
    ends.push(lineFeed + 1);
    lineStart = lineFeed + 1;
  }
  const mapped = units.join("");
  // Quotes, dashes and spaces are replaced one code unit for one.
  const folded = normalizeForFuzzyMatch(mapped);
  if (folded.length !== mapped.length || folded !== normalizeForFuzzyMatch(text)) return undefined;
  return { text: folded, starts, ends };
}

function codePointLength(text: string, at: number): number {
  return (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
}

/** Whether the code point at `at` starts a character instead of composing with the one before. */
function startsCharacter(text: string, at: number): boolean {
  const code = text.codePointAt(at) ?? 0;
  if (code < 0x300) return true;
  return !(
    /\p{M}/u.test(String.fromCodePoint(code)) ||
    // Hangul vowel and trailing jamo compose into the syllable before them.
    (code >= 0x1160 && code <= 0x11ff) ||
    (code >= 0xd7b0 && code <= 0xd7ff) ||
    // Kana voicing marks compose with the kana before them.
    code === 0x3099 ||
    code === 0x309a ||
    code === 0xff9e ||
    code === 0xff9f
  );
}
