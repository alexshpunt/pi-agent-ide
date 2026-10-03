import { createTextDocument } from "pi-agent-text";
import type { ResultRange } from "pi-agent-resource";
import { SelectionError } from "./selection-region.js";

interface SourceLine {
  readonly start: number;
  readonly length: number;
  readonly end: number;
}

/** Map retained text coordinates without normalizing line endings or splitting source characters. */
export class SourceText {
  public readonly lines: readonly SourceLine[];
  public constructor(public readonly content: string) {
    let start = 0;
    const document = createTextDocument("", content);
    const lines = document.lines.map((line) => {
      const from = start;
      start += line.content.length + line.lineEnding.length;
      return { start: from, length: line.content.length, end: start };
    });
    if (lines.length === 0 || document.lines.at(-1)?.lineEnding)
      lines.push({ start, length: 0, end: start });
    this.lines = lines;
  }

  /** Validate one exact character boundary, including CRLF and surrogate-pair integrity. */
  public boundary(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.content.length)
      throw new SelectionError("INVALID_RANGE", "Text bounds are outside the retained snapshot.");
    const left = this.content.charCodeAt(offset - 1);
    const right = this.content.charCodeAt(offset);
    if (
      (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) ||
      (left === 13 && right === 10)
    )
      throw new SelectionError(
        "INVALID_BOUNDARY",
        "Text boundary splits a surrogate pair or CRLF separator.",
      );
  }

  /** Resolve absolute source coordinates; columns do not include line-ending characters. */
  public offset(position: ResultRange["start"]): number {
    const line = this.lines[position.lineNumber - 1];
    if (
      !Number.isSafeInteger(position.lineNumber) ||
      !line ||
      !Number.isSafeInteger(position.column) ||
      position.column < 0 ||
      position.column > line.length
    )
      throw new SelectionError("INVALID_RANGE", "Source bounds are outside the retained snapshot.");
    const offset = line.start + position.column;
    this.boundary(offset);
    return offset;
  }

  /** Find the physical containing line, including separator bytes, without creating a boundary. */
  public lineIndex(offset: number): number {
    let low = 0;
    let high = this.lines.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((this.lines[middle]?.start ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** Convert a validated offset to an exclusive source position. */
  public position(offset: number): ResultRange["start"] {
    this.boundary(offset);
    const index = this.lineIndex(offset);
    return { lineNumber: index + 1, column: offset - (this.lines[index]?.start ?? 0) };
  }

  /** Build canonical character ranges; line endings remain represented by next-line column zero. */
  public range(from: number, to: number): ResultRange {
    if (to < from) throw new SelectionError("INVALID_RANGE", "Text bounds are reversed.");
    return { start: this.position(from), end: this.position(to) };
  }

  /** Return the complete physical lines touched by a half-open range or caret. */
  public fullLines(from: number, to: number): { from: number; to: number } {
    const first = this.lines[this.lineIndex(from)];
    const last = this.lines[this.lineIndex(to > from ? to - 1 : from)];
    if (!first || !last)
      throw new SelectionError("INVALID_RANGE", "Source line bounds are unavailable.");
    return { from: first.start, to: last.end };
  }
}
