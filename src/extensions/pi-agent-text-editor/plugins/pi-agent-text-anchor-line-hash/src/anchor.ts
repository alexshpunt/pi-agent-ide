import { requiredValue } from "pi-agent-invariant";

import {
  createTextDocument,
  isLineAnchor,
  linesWithAnchor,
  PRESENTED_LINE_ANCHOR_PATTERN,
  textLineAnchors,
  TextAnchor,
  type TextAnchorResolutionAttempt,
  type TextAnchorResolver,
  type TextAnchorResolverContext,
} from "pi-agent-text";

/** The most candidates a rejection lists. */
const MAX_CANDIDATES = 8;

class LineHashTextAnchor extends TextAnchor {
  public constructor(value: string, lineNumber: number) {
    super(value, lineNumber);
  }
}

function normalizeLineHashAnchor(value: string): string {
  const presented = PRESENTED_LINE_ANCHOR_PATTERN.exec(value)?.[1];
  if (presented !== undefined) {
    return presented;
  }
  const trimmed = value.trim();
  return isLineAnchor(trimmed) ? trimmed : value;
}

/** The anchors of the current text, whose lines are split as Read splits them. */
function currentAnchors(context: TextAnchorResolverContext): readonly string[] {
  return textLineAnchors(context.source, context.content);
}

/** The anchor of line `lineNumber` of `content`. */
export function createLineHashAnchor(content: string, lineNumber: number): TextAnchor {
  return new LineHashTextAnchor(formatLineHashAnchor(content, lineNumber), lineNumber);
}

/** The anchor of line `lineNumber` of `content`, as printed before the line. */
export function formatLineHashAnchor(content: string, lineNumber: number): string {
  return requiredValue(textLineAnchors("content", content)[lineNumber - 1]);
}

/** The lines of `content` from `startLine` to `endLine`, each with its anchor, as Read prints them. */
export function renderLineHashLines(content: string, startLine = 1, endLine?: number): string[] {
  const lines = createTextDocument("content", content).lines;
  const anchors = textLineAnchors("content", content);
  const first = Math.max(1, startLine);
  const last = Math.min(lines.length, endLine ?? lines.length);

  return lines
    .slice(first - 1, Math.max(first - 1, last))
    .map((line, index) => `${requiredValue(anchors[first + index - 1])}|${line.content}`);
}

export function createLineHashAnchorResolver(): TextAnchorResolver {
  return {
    id: "line-hash",
    description:
      "Use the complete 7-character anchor printed before a source line, for example `K7M2QX4`. It names the line by its content, so it stays valid while other lines change.",
    normalize: normalizeLineHashAnchor,
    renderFull(value) {
      return value;
    },
    renderCompact(_value, context) {
      return `line ${context.anchor.lineNumber}`;
    },
    tryResolve(value, context) {
      return Promise.resolve(resolveLineHashAnchor(value, context));
    },
    recover(value, context) {
      if (context.rejection.code !== "ambiguous") {
        return Promise.resolve({ kind: "unavailable" });
      }
      const lines = createTextDocument(context.source, context.content).lines;
      const numbers = linesWithAnchor(currentAnchors(context), value);
      return Promise.resolve({
        kind: "candidates",
        total: numbers.length,
        candidates: numbers.slice(0, MAX_CANDIDATES).map((lineNumber, index) => ({
          rank: index + 1,
          range: {
            start: { lineNumber, column: 0 },
            end: { lineNumber, column: requiredValue(lines[lineNumber - 1]).content.length },
          },
        })),
      });
    },
  };
}

function resolveLineHashAnchor(
  value: string,
  context: TextAnchorResolverContext,
): TextAnchorResolutionAttempt {
  if (!isLineAnchor(value)) {
    return { kind: "not-handled" };
  }

  const numbers = linesWithAnchor(currentAnchors(context), value);

  if (numbers.length === 1) {
    return { kind: "resolved", anchor: new LineHashTextAnchor(value, requiredValue(numbers[0])) };
  }

  if (numbers.length === 0) {
    // A value that no line produces but the file contains is exact text that happens to have the
    // shape of an anchor, such as `PACKAGE`; a stale anchor never occurs in the text it was for.
    if (context.content.includes(value)) {
      return { kind: "not-handled" };
    }
    return {
      kind: "rejected",
      rejection: {
        code: "stale",
        reason: `no line of the current file has anchor "${value}"; its line changed or was removed, so read or search again for current anchors`,
      },
    };
  }

  const shown = numbers
    .slice(0, MAX_CANDIDATES)
    .map((lineNumber) => `${lineNumber}`)
    .join(", ");
  return {
    kind: "rejected",
    rejection: {
      code: "ambiguous",
      reason: `anchor "${value}" names ${numbers.length} lines (${shown}${numbers.length > MAX_CANDIDATES ? ", …" : ""}); read them for distinct anchors`,
    },
  };
}
