import type { TextLine } from "./text-document.ts";

const SOURCE_LINE_METADATA_KEY = "pi-agent-text/source-line";

export interface TextSourceLine {
  readonly source: string;
  readonly lineNumber: number;
  readonly content: string;
  /**
   * The line's anchor in the whole source file. An anchor names content in context, so only the
   * code that holds the whole file can issue it; a mapped line without one is shown unanchored.
   */
  readonly anchor?: string;
}

export function getTextSourceLine(line: Pick<TextLine, "metadata">): TextSourceLine | undefined {
  const value = line.metadata?.[SOURCE_LINE_METADATA_KEY];

  if (!isTextSourceLine(value)) {
    return undefined;
  }

  return value;
}

export function withTextSourceLine(line: TextLine, sourceLine: TextSourceLine): TextLine {
  return {
    ...line,
    metadata: {
      ...line.metadata,
      [SOURCE_LINE_METADATA_KEY]: sourceLine,
    },
  };
}

function isTextSourceLine(value: unknown): value is TextSourceLine {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<TextSourceLine>;

  return (
    typeof candidate.source === "string" &&
    candidate.source.length > 0 &&
    typeof candidate.lineNumber === "number" &&
    Number.isInteger(candidate.lineNumber) &&
    candidate.lineNumber > 0 &&
    typeof candidate.content === "string" &&
    (candidate.anchor === undefined || typeof candidate.anchor === "string")
  );
}
