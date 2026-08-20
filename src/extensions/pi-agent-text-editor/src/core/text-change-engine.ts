import { requiredValue } from "../../../../utils/required-value.js";
import { ChangeSet, Text } from "@codemirror/state";

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

export class TextChangeDocument {
  readonly #lineStarts: readonly number[];
  readonly #separator: "\n" | "\r\n";

  public constructor(public readonly content: string) {
    this.#lineStarts = findLineStarts(content);
    this.#separator = content.includes("\r\n") ? "\r\n" : "\n";
  }

  public get length(): number {
    return this.content.length;
  }

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

  public replaceLines(firstLine: number, lastLine: number, text: string): TextChange {
    const range = this.lineRange(firstLine, lastLine);
    return { ...range, insert: this.#replacementText(range, text) };
  }

  public deleteLines(firstLine: number, lastLine: number): TextChange {
    const range = this.lineRange(firstLine, lastLine);

    if (range.to === this.content.length && range.from > 0 && !endsWithLineBreak(this.content)) {
      return { from: previousLineBreakStart(this.content, range.from), to: range.to, insert: "" };
    }

    return { ...range, insert: "" };
  }

  public insertBeforeLine(lineNumber: number, text: string): TextChange {
    this.#assertLine(lineNumber);
    const from = requiredValue(this.#lineStarts[lineNumber - 1]);
    return { from, to: from, insert: this.#withTrailingSeparator(text) };
  }

  public insertAfterLine(lineNumber: number, text: string): TextChange {
    this.#assertLine(lineNumber);
    const nextLine = this.#lineStarts[lineNumber];

    if (nextLine !== undefined) {
      return { from: nextLine, to: nextLine, insert: this.#withTrailingSeparator(text) };
    }

    const prefix =
      this.content.length > 0 && !endsWithLineBreak(this.content) ? this.#separator : "";
    return {
      from: this.content.length,
      to: this.content.length,
      insert: prefix + removeTrailingLineBreak(text),
    };
  }

  public replaceAll(text: string): TextChange {
    return { from: 0, to: this.content.length, insert: text };
  }

  #replacementText(range: TextRange, text: string): string {
    const selected = this.text(range);
    return endsWithLineBreak(selected) && !endsWithLineBreak(text)
      ? text + requiredValue(lineBreakOf(selected))
      : text;
  }

  #withTrailingSeparator(text: string): string {
    return endsWithLineBreak(text) ? text : text + this.#separator;
  }

  #offsetAt(lineNumber: number, column: number): number {
    this.#assertLine(lineNumber);

    if (!Number.isInteger(column) || column < 0) {
      throw new RangeError(`Column ${column} is outside line ${lineNumber}.`);
    }

    const start = requiredValue(this.#lineStarts[lineNumber - 1]);
    const next = this.#lineStarts[lineNumber];
    let end = next ?? this.content.length;

    if (next !== undefined) {
      end -= 1;

      if (this.content[end - 1] === "\r") {
        end -= 1;
      }
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

export function applyTextChanges(source: string, changes: readonly TextChange[]): TextChangeResult {
  const ordered = changes
    .map((change, index) => ({ change, index }))
    .sort((left, right) => left.change.from - right.change.from || left.index - right.index)
    .map(({ change }) => change);
  validateChanges(source.length, ordered);
  const document = Text.of([source]);
  const changeSet = ChangeSet.of(
    ordered.map((change) => ({ ...change, insert: Text.of([change.insert]) })),
    document.length,
  );
  const applied: AppliedTextChange[] = [];

  changeSet.iterChanges((fromBefore, toBefore, fromAfter, toAfter, inserted) => {
    applied.push({
      fromBefore,
      toBefore,
      fromAfter,
      toAfter,
      removedText: source.slice(fromBefore, toBefore),
      insertedText: inserted.toString(),
    });
  });

  return { content: changeSet.apply(document).toString(), changes: applied };
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
  const starts = [0];
  const lineBreak = /\r\n|\n/gu;
  let match: RegExpExecArray | null;

  while ((match = lineBreak.exec(text)) !== null) {
    starts.push(match.index + match[0].length);
  }

  return starts;
}

function endsWithLineBreak(text: string): boolean {
  return text.endsWith("\n");
}

function lineBreakOf(text: string): "\n" | "\r\n" | undefined {
  return text.endsWith("\r\n") ? "\r\n" : text.endsWith("\n") ? "\n" : undefined;
}

function removeTrailingLineBreak(text: string): string {
  return text.replace(/(?:\r\n|\n)$/u, "");
}

function previousLineBreakStart(text: string, offset: number): number {
  return text[offset - 2] === "\r" && text[offset - 1] === "\n" ? offset - 2 : offset - 1;
}
