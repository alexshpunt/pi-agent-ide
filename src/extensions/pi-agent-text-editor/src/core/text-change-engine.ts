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

const BOM = "\uFEFF";

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
  /** The selected end line for a mixed range whose end names a line's content boundary. */
  readonly endLine?: number;
}

/** Bytes from a source selection, without a whole-line span's final separator. */
export interface TextTransfer {
  readonly text: string;
  readonly wholeLines: boolean;
}

export interface TextInsertOptions {
  /** Insert at the start of the span instead of its end. */
  readonly before?: boolean;
  /**
   * At a line edge, "blank-line" separates a paragraph even without line breaks in the payload.
   * Mid-line insertions ignore separation.
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

  /** Copied bytes carry their line intent, but not the source's final line ending. */
  public transfer(span: TextSpan): TextTransfer {
    const lines = this.#wholeLines(span);
    const range = this.charSpan(span);
    return {
      text: this.content.slice(
        range.from,
        lines === undefined ? range.to : this.lineContentEnd(lines.last),
      ),
      wholeLines: lines !== undefined,
    };
  }

  /**
   * Writes over a span; empty text deletes it. Whole-line replacement keeps the last selected
   * line's ending. One trailing break in model text denotes the end of the last replacement line.
   */
  public replace(span: TextSpan, text: string | TextTransfer): TextChange {
    if (text === "" || (typeof text !== "string" && text.text === "" && !text.wholeLines))
      return this.delete(span);
    const lines = this.#wholeLines(span);
    const range = this.charSpan(span);
    if (lines === undefined && range.from === range.to && typeof text !== "string")
      return this.insert(range, text);
    const to = lines === undefined ? range.to : this.lineContentEnd(lines.last);
    const ending = getLineEndingAt(this.content, range.from);
    const written = this.#written(text, range.from, ending, lines !== undefined);
    return {
      from: range.from,
      to,
      insert:
        typeof text !== "string"
          ? written
          : keepLookalikeBytes(this.content.slice(range.from, to), written),
    };
  }

  /**
   * Deletes a span. Whole lines go with their line endings, leaving no empty line; when the last
   * of them has no ending, the ending before them goes instead.
   */
  public delete(span: TextSpan): TextChange {
    const lines = this.#wholeLines(span);
    return lines === undefined
      ? { ...this.charSpan(span), insert: "" }
      : this.#deleteLines(lines.first, lines.last);
  }

  #deleteLines(first: number, last: number): TextChange {
    const from = this.lineContentStart(first);
    const next = this.#lineStarts[last];
    if (next !== undefined) return { from, to: next, insert: "" };
    return {
      from: first > 1 ? this.lineContentEnd(first - 1) : from,
      to: this.content.length,
      insert: "",
    };
  }

  /** Deletes multiple selections, jointly accounting for the endings of adjacent lines. */
  public deleteSpans(spans: readonly TextSpan[]): TextChange[] {
    const lineSpans: { first: number; last: number }[] = [];
    const changes: TextChange[] = [];
    for (const span of spans) {
      const lines = this.#wholeLines(span);
      if (lines === undefined) changes.push({ ...this.charSpan(span), insert: "" });
      else lineSpans.push(lines);
    }
    lineSpans.sort((a, b) => a.first - b.first);
    const joined: { first: number; last: number }[] = [];
    for (const lines of lineSpans) {
      const previous = joined.at(-1);
      if (previous !== undefined && lines.first <= previous.last + 1)
        previous.last = Math.max(previous.last, lines.last);
      else joined.push({ ...lines });
    }

    for (const { first, last } of joined) changes.push(this.#deleteLines(first, last));
    changes.sort((a, b) => a.from - b.from);
    const result: TextChange[] = [];
    for (const change of changes) {
      const previous = result.at(-1);
      if (previous !== undefined && change.from <= previous.to)
        result[result.length - 1] = { ...previous, to: Math.max(previous.to, change.to) };
      else result.push(change);
    }
    return result;
  }

  /**
   * Inserts at a span's boundary. Multiline input and whole-line transfers insert separate
   * lines at a line edge; everything else inserts at the exact boundary.
   */
  public insert(
    span: TextSpan,
    text: string | TextTransfer,
    options: TextInsertOptions = {},
  ): TextChange {
    const range = this.charSpan(span);
    const at = options.before === true ? range.from : range.to;
    const line = this.lineNumberAt(at);
    const atStart = at === this.lineContentStart(line);
    const atEnd = at === this.lineContentEnd(line);
    const separation = options.separation ?? "line";
    const wholeTransfer = typeof text !== "string" && text.wholeLines;
    const separate =
      (atStart || atEnd) &&
      (wholeTransfer ||
        separation === "blank-line" ||
        (typeof text === "string" && /[\r\n]/u.test(text)));
    // At the start of an empty line, stay before it unless the span ends on that line itself.
    const afterLine = atEnd && (!atStart || this.#wholeLines(span)?.last === line);
    const offset =
      separate && afterLine && options.before !== true ? (this.#lineStarts[line] ?? at) : at;
    const ending = getLineEndingAt(this.content, offset);
    const written = this.#written(text, offset, ending);
    if (written.length === 0 && typeof text === "string")
      throw new Error("Insert text must not be empty.");
    if (!separate || (written.length === 0 && !wholeTransfer))
      return { from: offset, to: offset, insert: written };

    // The destination supplies the first separator. Keep extra breaks, all-break payloads,
    // and transferred bytes.
    const block =
      typeof text === "string" && written.startsWith(ending) && /[^\r\n]/u.test(written)
        ? written.slice(ending.length)
        : written;
    return {
      from: offset,
      to: offset,
      insert: this.#lineInsertion(offset, block, separation, ending, wholeTransfer),
    };
  }

  public replaceAll(text: string): TextChange {
    return { from: 0, to: this.content.length, insert: text };
  }

  #wholeLines(span: TextSpan): TextSpan["lines"] {
    const { from, to } = this.charSpan(span);
    const first = this.lineNumberAt(from);
    if (from !== this.lineContentStart(first)) return undefined;
    const endLine = this.lineNumberAt(to);
    const atEnd = to === this.lineContentEnd(endLine);
    // At an empty physical line, the same offset is both the end of the previous ending
    // and the end of the empty content. An explicit line selection can include that blank.
    if (
      atEnd &&
      (span.lines?.last ?? span.endLine) === endLine &&
      this.#lineStarts[endLine] !== undefined
    )
      return { first, last: endLine };
    if (from === to) return undefined;
    if (endLine > first && to === this.lineContentStart(endLine))
      return { first, last: endLine - 1 };
    return atEnd ? { first, last: endLine } : undefined;
  }

  /** Copied bytes stay verbatim; a model's text takes the destination's line endings. */
  #written(
    input: string | TextTransfer,
    offset: number,
    ending: string,
    replaceLines = false,
  ): string {
    const sent = typeof input === "string" ? input : input.text;
    const text =
      this.#bom > 0 && offset === this.#bom && sent.startsWith(BOM) ? sent.slice(1) : sent;
    if (typeof input !== "string") return text;
    const lf = normalizeToLF(text);
    const body = replaceLines && lf.endsWith("\n") ? lf.slice(0, -1) : lf;
    return ending === "\n" ? body : body.replaceAll("\n", ending);
  }

  /** A character span; it never includes the BOM. */
  public charSpan(span: TextRange): TextRange {
    this.#assertRange(span);
    return { from: Math.max(span.from, this.#bom), to: Math.max(span.to, this.#bom) };
  }

  #lineInsertion(
    at: number,
    text: string,
    separation: LineSeparation,
    separator: string,
    wholeTransfer: boolean,
  ): string {
    const atLineStart = at <= this.#bom || this.content[at - 1] === "\n";
    const following = at < this.content.length;
    const lineBreakFollows = /^\r?\n/u.test(this.content.slice(at, at + 2));
    let prefix = atLineStart ? "" : separator;
    if (
      separation === "blank-line" &&
      at > this.#bom &&
      !endsWithBlankLine(this.content, at, this.#bom) &&
      !/^\r?\n/u.test(text)
    ) {
      prefix += separator;
    }
    const endsWithBreak = !wholeTransfer && text.endsWith(separator);
    let suffix = "";
    if (following) {
      if (separation === "blank-line" && !/\n\r?\n$/u.test(text) && !lineBreakFollows) {
        suffix = endsWithBreak ? separator : separator + separator;
      } else if (!endsWithBreak && (atLineStart || !lineBreakFollows)) {
        suffix = separator;
      }
    } else if (atLineStart && at > this.#bom && !endsWithBreak) {
      // The file ended with a line break: the inserted line keeps it last.
      suffix = separator;
    }
    // A terminator in the input marks the end of the inserted line, but doesn't add a new
    // terminator after the inserted lines if the nonempty file had an unterminated last line.
    const useExistingEnding = !atLineStart && (lineBreakFollows || !following);
    return (
      prefix +
      (endsWithBreak && useExistingEnding ? text.slice(0, -separator.length) : text) +
      suffix
    );
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

/** Whether the text before `end` finishes with an empty line, or is empty after `start`. */
function endsWithBlankLine(text: string, end: number, start: number): boolean {
  if (end <= start || text[end - 1] !== "\n") return false;
  let lineEnd = end - 1;
  if (lineEnd > start && text[lineEnd - 1] === "\r") lineEnd -= 1;
  return lineEnd <= start || text[lineEnd - 1] === "\n";
}
