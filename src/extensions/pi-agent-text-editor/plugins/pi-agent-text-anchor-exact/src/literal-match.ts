import type { AnchoredLiteralView } from "./anchored-literal-view.ts";
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
  find(content, value, accept, limit) {
    const query = normalizeForFuzzyMatch(normalizeToLF(splitBom(value).text));
    if (query.length === 0) return [];
    const { bom, text } = splitBom(content);
    const normalized = normalizeToLF(text);
    const folded = normalizeForFuzzyMatch(normalized);
    if (!folded.includes(query)) return [];
    const unitAt = fuzzyUnits(normalized, folded);
    if (unitAt === undefined) return [];
    const toSource = sourceOffsets(text, bom.length);
    return scan(
      folded,
      query,
      (start) => {
        const end = start + query.length;
        const first = unitAt(start);
        const last = unitAt(end - 1);
        if (first === undefined || last === undefined) return undefined;
        const cutsStart = start > 0 && unitAt(start - 1)?.from === first.from;
        const cutsEnd = end < folded.length && unitAt(end)?.from === last.from;
        return cutsStart || cutsEnd
          ? undefined
          : { from: toSource(first.from), to: toSource(last.to) };
      },
      accept,
      limit,
    );
  },
};

/** Literal matchers from strict to tolerant. */
const LITERAL_MATCHERS: readonly LiteralMatcher[] = [exactMatcher, lineEndingMatcher, fuzzyMatcher];

export type LiteralMatch =
  | { readonly kind: "unique"; readonly span: LiteralSpan }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "missing" };

/** Finds the one source span the literal selects: the first phase that finds it decides. */
export function matchLiteral(
  content: string,
  value: string,
  anchored: AnchoredLiteralView,
  accept: (span: LiteralSpan) => boolean = () => true,
): LiteralMatch {
  const [first, second] = firstMatches(content, value, anchored, accept, 2);
  if (second !== undefined) return { kind: "ambiguous" };
  if (first !== undefined) return { kind: "unique", span: first };
  return { kind: "missing" };
}

/** Every source span from the first matching phase, including overlaps. */
export function literalCandidates(
  content: string,
  value: string,
  anchored: AnchoredLiteralView,
  accept: (span: LiteralSpan) => boolean = () => true,
): readonly LiteralSpan[] {
  return firstMatches(content, value, anchored, accept, Number.MAX_SAFE_INTEGER);
}

function firstMatches(
  content: string,
  value: string,
  anchored: AnchoredLiteralView,
  accept: (span: LiteralSpan) => boolean,
  limit: number,
): LiteralSpan[] {
  if (value.length === 0) return [];
  for (const matcher of LITERAL_MATCHERS) {
    const spans = matcher.find(content, value, accept, limit);
    if (spans.length > 0) return spans;
  }
  return anchored.find(value, LITERAL_MATCHERS, accept, limit);
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
 * Maps each code unit of `folded`, `normalizeForFuzzyMatch(text)`, to the span of `text` it
 * came from. Lines are mapped only when asked for, since only the lines of a match are needed.
 * Returns undefined for a unit of a line whose mapping differs from `folded`, so a fuzzy match
 * never maps to the wrong source.
 */
function fuzzyUnits(
  text: string,
  folded: string,
): ((offset: number) => LiteralSpan | undefined) | undefined {
  // Fuzzy normalization works within lines, so line N of `folded` comes from line N of `text`.
  const textLines = lineStarts(text);
  const foldedLines = lineStarts(folded);
  if (textLines.length !== foldedLines.length) return undefined;
  const lines = new Map<number, FuzzyLine | undefined>();
  return (offset) => {
    let line = 0;
    let high = foldedLines.length - 1;
    while (line < high) {
      const middle = (line + high + 1) >>> 1;
      if ((foldedLines[middle] ?? 0) <= offset) line = middle;
      else high = middle - 1;
    }
    const textStart = textLines[line] ?? 0;
    const textEnd = (textLines[line + 1] ?? text.length + 1) - 1;
    const foldedStart = foldedLines[line] ?? 0;
    const foldedEnd = (foldedLines[line + 1] ?? folded.length + 1) - 1;
    // The LF that ends the line.
    if (offset === foldedEnd) return { from: textEnd, to: textEnd + 1 };
    if (!lines.has(line)) {
      const mapped = fuzzyLine(text.slice(textStart, textEnd));
      lines.set(line, mapped?.text === folded.slice(foldedStart, foldedEnd) ? mapped : undefined);
    }
    const unit = lines.get(line)?.unitAt(offset - foldedStart);
    return unit === undefined
      ? undefined
      : { from: textStart + unit.from, to: textStart + unit.to };
  };
}

/** The offsets where the lines of `text` start. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (
    let lineFeed = text.indexOf("\n");
    lineFeed !== -1;
    lineFeed = text.indexOf("\n", lineFeed + 1)
  )
    starts.push(lineFeed + 1);
  return starts;
}

/**
 * A line of Latin text, special spaces, dashes and quotes: BMP characters that NFKC never
 * composes with a neighbour. When NFKC keeps the length of such a line, no character expanded,
 * so every character maps to exactly one code unit.
 */
const ONE_TO_ONE_LINE =
  /^[\0-\u02FF\u2002-\u200A\u2010-\u2015\u2018-\u201F\u202F\u205F\u2212\u3000]*$/u;

/** A line's fuzzy text and the range of the line each of its code units came from. */
interface FuzzyLine {
  readonly text: string;
  unitAt(column: number): LiteralSpan | undefined;
}

/**
 * `normalizeForFuzzyMatch(line)`, normalized one character at a time, a character being a code
 * point with the marks that can compose with it. Undefined when the quote, dash and space
 * replacements change the length, so units would no longer line up with their source.
 */
function fuzzyLine(line: string): FuzzyLine | undefined {
  // Most lines hold only characters that stand alone and that NFKC keeps or maps to one code
  // unit; there each unit of the fuzzy text comes from the unit at the same column.
  if (ONE_TO_ONE_LINE.test(line) && line.normalize("NFKC").length === line.length) {
    const text = normalizeForFuzzyMatch(line);
    return {
      text,
      unitAt: (column) => (column < text.length ? { from: column, to: column + 1 } : undefined),
    };
  }
  const units: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let from = 0; from < line.length;) {
    let to = from + codePointLength(line, from);
    while (to < line.length && !startsCharacter(line, to)) to += codePointLength(line, to);
    const normalized = line.slice(from, to).normalize("NFKC");
    for (const unit of normalized.split("")) {
      units.push(unit);
      starts.push(from);
      ends.push(to);
    }
    from = to;
  }
  // Pi strips trailing whitespace from each line.
  const trimmed = units.join("").trimEnd();
  const text = normalizeForFuzzyMatch(trimmed);
  if (text.length !== trimmed.length) return undefined;
  return {
    text,
    unitAt: (column) => {
      const from = starts[column];
      const to = ends[column];
      return column >= text.length || from === undefined || to === undefined
        ? undefined
        : { from, to };
    },
  };
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
