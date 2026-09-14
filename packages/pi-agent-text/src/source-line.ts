import type { TextLine } from "./text-document.js";

const SOURCE_LINE_METADATA_KEY = "pi-agent-text/source-line";

export interface TextSourceLine {
  readonly source: string;
  readonly lineNumber: number;
  readonly content: string;
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
    typeof candidate.content === "string"
  );
}
