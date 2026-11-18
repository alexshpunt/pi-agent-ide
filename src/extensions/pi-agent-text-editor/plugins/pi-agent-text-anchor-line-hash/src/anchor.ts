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

import type { LineHashRangeHistory } from "./range-history.ts";

/** The most candidates a rejection lists. */
const MAX_CANDIDATES = 8;

class LineHashTextAnchor extends TextAnchor {
  public constructor(
    value: string,
    lineNumber: number,
    private readonly origin?: { readonly source: string; readonly history: LineHashRangeHistory },
  ) {
    super(value, lineNumber);
  }

  public override rangeRejection(end: TextAnchor, selected: string) {
    if (!(end instanceof LineHashTextAnchor) || this.origin === undefined) return undefined;
    const { source, history } = this.origin;
    const result = history.check(source, this.value, end.value, selected);
    if (result === "unchanged") return undefined;
    return {
      code: "STALE_ANCHOR_RANGE",
      reason:
        result === "changed"
          ? "The text between these line anchors changed since they were shown. Read the range and select it with exact text or a result reference for the whole span."
          : "No retained source window verifies this pair of line anchors. Read both endpoints together, or use exact text or a result reference for the whole span.",
    };
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

export function createLineHashAnchorResolver(history?: LineHashRangeHistory): TextAnchorResolver {
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
      return Promise.resolve(resolveLineHashAnchor(value, context, history));
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
  history: LineHashRangeHistory | undefined,
): TextAnchorResolutionAttempt {
  if (!isLineAnchor(value)) {
    return { kind: "not-handled" };
  }

  const numbers = linesWithAnchor(currentAnchors(context), value);

  if (numbers.length === 1) {
    return {
      kind: "resolved",
      anchor: new LineHashTextAnchor(
        value,
        requiredValue(numbers[0]),
        history === undefined ? undefined : { source: context.source, history },
      ),
    };
  }

  if (numbers.length === 0) {
    return {
      kind: "rejected",
      rejection: {
        code: "stale",
        reason: `no line of the current file has anchor "${value}"; read or search again for current anchors. To select these bytes literally, use a Search result or longer exact text`,
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
