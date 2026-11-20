import { requiredValue } from "pi-agent-invariant";
import { getLineEndingAt, normalizeToLF } from "#src/api/pi-edit-text.ts";
import { keepLookalikeBytes } from "#src/core/lookalike-bytes.ts";

export interface TextRange {
  readonly from: number;
  readonly to: number;
}

export interface TextChange extends TextRange {
  readonly insert: string;
}

export interface AppliedTextChange {
  readonly fromBefore: number;
  readonly toBefore: number;
  readonly fromAfter: number;
  readonly toAfter: number;
  readonly removedText: string;
  readonly insertedText: string;
}

export interface TextChangeResult {
  readonly content: string;
  readonly changes: readonly AppliedTextChange[];
}

export type LineSeparation = "line" | "blank-line";

/**
 * The place a selector resolved. Selectors only locate: every edit writes through the document's
 * `replace`, `delete` and `insert`, whatever selected the span.
 */
export interface TextSpan extends TextRange {
  /**
   * Set when the span selects whole lines. Then `from` is the first line's content start (after a
   * BOM) and `to` the last line's content end (before its line ending).
   */
  readonly lines?: { readonly first: number; readonly last: number };
}

export interface TextWriteOptions {
  /** Text copied from a file keeps its own line breaks; text sent by a model takes the file's. */
  readonly verbatim?: boolean;
}

export interface TextInsertOptions extends TextWriteOptions {
  /** Insert at the start of the span instead of its end. */
  readonly before?: boolean;
  /**
   * How whole-line insertions are separated; default "line". Over a character span, "line"
   * inserts exactly at the boundary.
   */
  readonly separation?: LineSeparation;
}

export class TextChangeDocument {
  readonly #lineStarts: readonly number[];
  /** Length of a leading BOM: it belongs to no line and no span. */
  readonly #bom: number;

  public constructor(public readonly content: string) {
    this.#lineStarts = findLineStarts(content);
    this.#bom = content.startsWith("\uFEFF") ? 1 : 0;
  }

  public get length(): number {
    return this.content.length;
  }

  /** One-based number of the line containing an offset in the current snapshot. */
  public lineNumberAt(offset: number): number {
    this.#assertRange({ from: offset, to: offset });
    let first = 0;
    let last = this.#lineStarts.length;
    while (first < last) {
      const mid = Math.floor((first + last) / 2);
      if (requiredValue(this.#lineStarts[mid]) <= offset) first = mid + 1;
      else last = mid;
    }
    return first;
  }

  /** Raw extent of lines with their line endings, and on line 1 with the BOM. */
  public lineRange(firstLine: number, lastLine: number): TextRange {
    const first = Math.min(firstLine, lastLine);
    const last = Math.max(firstLine, lastLine);
    this.#assertLine(first);
    this.#assertLine(last);

    return {
      from: requiredValue(this.#lineStarts[first - 1]),
      to: this.#lineStarts[last] ?? this.content.length,
    };
  }

  /** Whole lines as a span: their content, without a BOM and the last line's ending. */
  public lineSpan(firstLine: number, lastLine: number): TextSpan {
    const first = Math.min(firstLine, lastLine);
    const last = Math.max(firstLine, lastLine);
    this.#assertLine(first);
    this.#assertLine(last);
    return {
      from: this.lineContentStart(first),
      to: this.lineContentEnd(last),
      lines: { first, last },
    };
  }

  /** Offset where a line's content starts: after a BOM on line 1. */
  public lineContentStart(lineNumber: number): number {
    this.#assertLine(lineNumber);
    return Math.max(requiredValue(this.#lineStarts[lineNumber - 1]), this.#bom);
  }

  /** Offset where a line's content ends: before its LF or CRLF. */
  public lineContentEnd(lineNumber: number): number {
    this.#assertLine(lineNumber);
    const next = this.#lineStarts[lineNumber];
    if (next === undefined) return this.content.length;
    const start = this.lineContentStart(lineNumber);
    return next - 2 >= start && this.content[next - 2] === "\r" ? next - 2 : next - 1;
  }

  public range(
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
  ): TextRange {
    const from = this.#offsetAt(startLine, startColumn);
    const to = this.#offsetAt(endLine, endColumn);

    if (to < from) {
      throw new RangeError(`Text range ${from}-${to} is reversed.`);
    }

    return { from, to };
  }

  public text(range: TextRange): string {
    this.#assertRange(range);
    return this.content.slice(range.from, range.to);
  }

  /**
   * Writes `text` over a span; empty text deletes it. Line breaks in the text take the line ending
   * of the line where the span starts. Over whole lines, their content is replaced and the last
   * line keeps its own ending, so one trailing line break of the text is dropped.
   */
  public replace(span: TextSpan, text: string, options: TextWriteOptions = {}): TextChange {
    if (text.length === 0) return this.delete(span);
    const range = this.charSpan(span);
    const written = this.#written(text, range.from, options, span.lines !== undefined);
    return {
      ...range,
      // Copied bytes are written as they are; text a model sent keeps the original bytes of
      // look-alike characters that it retyped outside what it changed.
      insert:
        options.verbatim === true
          ? written
          : keepLookalikeBytes(this.content.slice(range.from, range.to), written),
    };
  }

  /**
   * Deletes a span. Whole lines go with their line endings, leaving no empty line; when the last
   * of them has no ending, the ending before them goes instead.
   */
  public delete(span: TextSpan): TextChange {
    if (span.lines === undefined) return { ...this.charSpan(span), insert: "" };
    const { first, last } = span.lines;
    const from = this.lineContentStart(first);
    const next = this.#lineStarts[last];
    if (next !== undefined) return { from, to: next, insert: "" };
    return {
      from: first > 1 ? this.lineContentEnd(first - 1) : from,
      to: this.content.length,
      insert: "",
    };
  }

  /**
   * Inserts `text` at the start or end of a span. Its line breaks, and the separators added around
   * whole lines, take the line ending at the insertion point. A file that ends with a line break
   * keeps it; one that does not stays without.
   */
  public insert(span: TextSpan, text: string, options: TextInsertOptions = {}): TextChange {
    if (text.length === 0) throw new Error("Insert text must not be empty.");
    const range = this.charSpan(span);
    const at =
      options.before === true
        ? range.from
        : span.lines === undefined
          ? range.to
          : (this.#lineStarts[span.lines.last] ?? this.content.length);
    const separation = options.separation ?? "line";
    const written = this.#written(text, at, options, false);
    if (span.lines === undefined && separation === "line")
      return { from: at, to: at, insert: written };
    return {
      from: at,
      to: at,
      insert: this.#lineInsertion(at, written, separation, getLineEndingAt(this.content, at)),
    };
  }

  public replaceAll(text: string): TextChange {
    return { from: 0, to: this.content.length, insert: text };
  }

  /**
   * Text as written at `offset`: as sent for copied bytes, else with the line's ending. With
   * `lines`, one trailing line break is dropped first, since the last line keeps its own ending.
   */
  #written(text: string, offset: number, options: TextWriteOptions, lines: boolean): string {
    if (options.verbatim === true) return lines ? withoutFinalLineBreak(text) : text;
    const lf = normalizeToLF(text);
    const sent = lines && lf.endsWith("\n") ? lf.slice(0, -1) : lf;
    const lineEnding = getLineEndingAt(this.content, offset);
    return lineEnding === "\n" ? sent : sent.replaceAll("\n", lineEnding);
  }

  /** A character span; it never includes the BOM. */
  public charSpan(span: TextRange): TextRange {
    this.#assertRange(span);
    return { from: Math.max(span.from, this.#bom), to: Math.max(span.to, this.#bom) };
  }

  #lineInsertion(at: number, text: string, separation: LineSeparation, separator: string): string {
    const atLineStart = at <= this.#bom || this.content[at - 1] === "\n";
    const following = at < this.content.length;
    let prefix = atLineStart ? "" : separator;
    if (
      separation === "blank-line" &&
      at > this.#bom &&
      !endsWithBlankLine(this.content, at, this.#bom) &&
      !/^\r?\n/u.test(text)
    ) {
      prefix += separator;
    }
    let suffix = "";
    if (following) {
      if (
        separation === "blank-line" &&
        !/\n\r?\n$/u.test(text) &&
        !/^\r?\n/u.test(this.content.slice(at, at + 2))
      ) {
        suffix = endsWithLineBreak(text) ? separator : separator + separator;
      } else if (!endsWithLineBreak(text)) {
        suffix = separator;
      }
    } else if (atLineStart && at > this.#bom && !endsWithLineBreak(text)) {
      // The file ended with a line break: the inserted line keeps it last.
      suffix = separator;
    }
    return prefix + text + suffix;
  }

  #offsetAt(lineNumber: number, column: number): number {
    this.#assertLine(lineNumber);

    if (!Number.isInteger(column) || column < 0) {
      throw new RangeError(`Column ${column} is outside line ${lineNumber}.`);
    }

    const start = requiredValue(this.#lineStarts[lineNumber - 1]);
    const next = this.#lineStarts[lineNumber];
    let end = next ?? this.content.length;

    // Only LF ends a line: a CRLF line's CR is its last character.
    if (next !== undefined) {
      end -= 1;
    }

    if (start + column > end) {
      throw new RangeError(`Column ${column} is outside line ${lineNumber}.`);
    }

    return start + column;
  }

  #assertLine(lineNumber: number): void {
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > this.#lineStarts.length) {
      throw new RangeError(`Line ${lineNumber} is outside the document.`);
    }
  }

  #assertRange(range: TextRange): void {
    if (range.from < 0 || range.to < range.from || range.to > this.content.length) {
      throw new RangeError(`Text range ${range.from}-${range.to} is outside the document.`);
    }
  }
}

/**
 * Apply validated ranges. A change whose range already has its text is kept: the edit treats
 * that target as already done.
 */
export function applyTextChanges(source: string, changes: readonly TextChange[]): TextChangeResult {
  const ordered = changes
    .map((change, index) => ({ change, index }))
    .sort((left, right) => left.change.from - right.change.from || left.index - right.index)
    .map(({ change }) => change);
  validateChanges(source.length, ordered);
  // One pass over the source: each change copies only the text up to it, so many changes in a
  // large file cost the file's length once, not once per change.
  const parts: string[] = [];
  const applied: AppliedTextChange[] = [];
  let copied = 0;
  let shift = 0;
  for (const change of ordered) {
    if (change.from === change.to && change.insert.length === 0) continue;
    parts.push(source.slice(copied, change.from), change.insert);
    copied = change.to;
    const previous = applied.at(-1);
    // Changes that touch are reported as one, with their removed and inserted text joined.
    if (previous !== undefined && previous.toBefore === change.from) {
      applied[applied.length - 1] = {
        ...previous,
        toBefore: change.to,
        toAfter: previous.toAfter + change.insert.length,
        removedText: previous.removedText + source.slice(change.from, change.to),
        insertedText: previous.insertedText + change.insert,
      };
    } else {
      applied.push({
        fromBefore: change.from,
        toBefore: change.to,
        fromAfter: change.from + shift,
        toAfter: change.from + shift + change.insert.length,
        removedText: source.slice(change.from, change.to),
        insertedText: change.insert,
      });
    }
    shift += change.insert.length - (change.to - change.from);
  }
  parts.push(source.slice(copied));
  return { content: parts.join(""), changes: applied };
}

function validateChanges(length: number, changes: readonly TextChange[]): void {
  let previous: TextChange | undefined;

  for (const change of changes) {
    if (
      !Number.isInteger(change.from) ||
      !Number.isInteger(change.to) ||
      change.from < 0 ||
      change.to < change.from ||
      change.to > length
    ) {
      throw new RangeError(`Text change ${change.from}-${change.to} is outside the document.`);
    }

    if (previous !== undefined && (change.from < previous.from || change.from < previous.to)) {
      throw new Error("Text changes must be ordered and must not overlap.");
    }

    previous = change;
  }
}

function findLineStarts(text: string): number[] {
  // Both line breaks end with "\n", so every line after the first starts after one. indexOf
  // avoids a match object per line of a large file.
  const starts = [0];
  for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", end + 1))
    starts.push(end + 1);
  return starts;
}

function endsWithLineBreak(text: string): boolean {
  return text.endsWith("\n");
}

/** Drops one trailing LF or CRLF. */
function withoutFinalLineBreak(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** Whether the text before `end` finishes with an empty line, or is empty after `start`. */
function endsWithBlankLine(text: string, end: number, start: number): boolean {
  if (end <= start || text[end - 1] !== "\n") return false;
  let lineEnd = end - 1;
  if (lineEnd > start && text[lineEnd - 1] === "\r") lineEnd -= 1;
  return lineEnd <= start || text[lineEnd - 1] === "\n";
}
