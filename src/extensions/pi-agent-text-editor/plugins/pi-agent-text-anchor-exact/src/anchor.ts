import {
  type TextAnchorRecoveryCandidateRange,
  type TextAnchorResolutionAttempt,
  type TextAnchorResolver,
  type TextAnchorResolverContext,
} from "pi-agent-text";
import {
  TextSelectionAnchor,
  type TextSelectionPosition,
} from "pi-agent-text-editor/api/text-selection-anchor";

import type { ExactTextRecoveryConfig } from "./config.ts";
import { recoverExactText } from "./recovery.ts";

/** Text with CRLF and CR line breaks normalized to LF, and a map back to source offsets. */
interface NormalizedText {
  readonly text: string;
  /** Maps an offset in `text` to the matching offset in the source. */
  readonly sourceOffset: (offset: number) => number;
}

/** Creates the catch-all resolver for unique exact text spans. */
export function createExactTextAnchorResolver(
  config: ExactTextRecoveryConfig,
  requiresAnchor: (source: string, cwd: string, value: string) => boolean = () => false,
): TextAnchorResolver {
  return {
    id: "exact-text",
    description:
      "Any non-empty value not handled as a structured anchor selects one unique exact text span.",
    renderFull(value) {
      return value;
    },
    renderCompact() {
      return "selected text";
    },
    tryResolve(value, context) {
      return Promise.resolve(
        requiresAnchor(context.source, context.cwd, value)
          ? rejected(
              "invalid",
              "Exact-text editing is blocked for this file; use a current returned anchor for the next edit.",
            )
          : resolveExactTextAnchor(value, context),
      );
    },
    recover(value, context) {
      return recoverExactText(value, context, config);
    },
  };
}

/** Resolves a unique EOL-normalized text value without changing the source. */
export function resolveExactTextAnchor(
  value: string,
  context: TextAnchorResolverContext,
): TextAnchorResolutionAttempt {
  if (value.length === 0) {
    return rejected("invalid", "exact text anchor must be non-empty");
  }

  const source = normalizeText(stripInitialBom(context.content));
  const query = normalizeText(stripInitialBom(value)).text;
  const matches = overlappingMatches(source.text, query, 2);

  if (matches.length === 0) {
    return rejected("missing", "exact text anchor was not found");
  }

  if (matches.length > 1) {
    return rejected("ambiguous", "exact text anchor matched more than once");
  }

  const normalizedStart = matches[0];
  if (normalizedStart === undefined) {
    return { kind: "failed", error: new Error("Exact match index is missing") };
  }

  const bomOffset = context.content.startsWith("\uFEFF") ? 1 : 0;
  const startOffset = bomOffset + source.sourceOffset(normalizedStart);
  const endOffset = bomOffset + source.sourceOffset(normalizedStart + query.length);

  const linewise = isWholeLineMatch(context.content, startOffset, endOffset);
  const selectionEndOffset =
    linewise && !query.endsWith("\n")
      ? includeTrailingLineBreak(context.content, endOffset)
      : endOffset;
  const range = {
    start: positionAt(context.content, startOffset),
    end: positionAt(context.content, selectionEndOffset),
    ...(linewise && { linewise: true }),
  };
  return {
    kind: "resolved",
    anchor: new TextSelectionAnchor(
      value,
      context.source,
      [range],
      [{ start: range.start, end: positionAt(context.content, endOffset) }],
    ),
  };
}

/** Finds exact matches and maps their spans to the original source positions. */
export function findExactTextMatches(
  value: string,
  context: TextAnchorResolverContext,
  limit: number,
): { readonly ranges: readonly TextAnchorRecoveryCandidateRange[]; readonly total: number } {
  const source = normalizeText(stripInitialBom(context.content));
  const query = normalizeText(stripInitialBom(value)).text;
  if (query.length === 0) {
    return { ranges: [], total: 0 };
  }
  const matches = scanMatches(source.text, query, limit);
  const bomOffset = context.content.startsWith("\uFEFF") ? 1 : 0;
  return {
    total: matches.total,
    ranges: matches.starts.map((start) => ({
      start: positionAt(context.content, bomOffset + source.sourceOffset(start)),
      end: positionAt(context.content, bomOffset + source.sourceOffset(start + query.length)),
    })),
  };
}

function isWholeLineMatch(content: string, start: number, end: number): boolean {
  const startsAtLineBoundary =
    start === 0 || content[start - 1] === "\n" || content[start - 1] === "\r";
  const endsAtLineBoundary =
    end === content.length ||
    content[end] === "\n" ||
    content[end] === "\r" ||
    content[end - 1] === "\n" ||
    content[end - 1] === "\r";
  return startsAtLineBoundary && endsAtLineBoundary;
}

function includeTrailingLineBreak(content: string, end: number): number {
  if (content[end] === "\r" && content[end + 1] === "\n") {
    return end + 2;
  }
  return content[end] === "\r" || content[end] === "\n" ? end + 1 : end;
}
function rejected(
  code: "invalid" | "missing" | "ambiguous",
  reason: string,
): TextAnchorResolutionAttempt {
  return { kind: "rejected", rejection: { code, reason } };
}

function stripInitialBom(value: string): string {
  return value.startsWith("\uFEFF") ? value.slice(1) : value;
}

function normalizeText(value: string): NormalizedText {
  if (!value.includes("\r")) {
    return { text: value, sourceOffset: (offset) => checkedOffset(offset, value.length) };
  }

  // Each CRLF becomes one LF, so a normalized offset maps back by adding the CRLFs before it.
  const collapsed: number[] = [];
  let removed = 0;
  for (let crlf = value.indexOf("\r\n"); crlf !== -1; crlf = value.indexOf("\r\n", crlf + 2)) {
    collapsed.push(crlf - removed);
    removed += 1;
  }
  const text = value.replace(/\r\n?/gu, "\n");
  return {
    text,
    sourceOffset: (offset) => checkedOffset(offset, text.length) + countBefore(collapsed, offset),
  };
}

function checkedOffset(offset: number, length: number): number {
  if (offset < 0 || offset > length) {
    throw new RangeError("Exact text match is outside normalized source boundaries");
  }
  return offset;
}

/** Counts sorted positions lower than `offset`. */
function countBefore(positions: readonly number[], offset: number): number {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((positions[middle] ?? Infinity) < offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function overlappingMatches(content: string, query: string, limit: number): number[] {
  if (query.length === 0) {
    return [];
  }
  const starts: number[] = [];
  let from = 0;
  while (starts.length < limit && from <= content.length - query.length) {
    const match = content.indexOf(query, from);
    if (match === -1) {
      break;
    }
    starts.push(match);
    from = match + 1;
  }
  return starts;
}

function scanMatches(
  content: string,
  query: string,
  limit: number,
): { readonly starts: number[]; readonly total: number } {
  if (query.length === 0) {
    return { starts: [], total: 0 };
  }
  const starts: number[] = [];
  let total = 0;
  let from = 0;
  while (from <= content.length - query.length) {
    const match = content.indexOf(query, from);
    if (match === -1) {
      break;
    }
    total += 1;
    if (starts.length < limit) {
      starts.push(match);
    }
    from = match + 1;
  }
  return { starts, total };
}

function positionAt(content: string, offset: number): TextSelectionPosition {
  let lineNumber = 1;
  let lineStart = 0;
  let nextCr = content.indexOf("\r");
  let nextLf = content.indexOf("\n");
  for (;;) {
    const lineBreak = nextCr === -1 ? nextLf : nextLf === -1 ? nextCr : Math.min(nextCr, nextLf);
    if (lineBreak === -1 || lineBreak >= offset) {
      break;
    }
    lineStart =
      content[lineBreak] === "\r" && content[lineBreak + 1] === "\n"
        ? lineBreak + 2
        : lineBreak + 1;
    lineNumber += 1;
    if (nextCr !== -1 && nextCr < lineStart) {
      nextCr = content.indexOf("\r", lineStart);
    }
    if (nextLf !== -1 && nextLf < lineStart) {
      nextLf = content.indexOf("\n", lineStart);
    }
  }
  return { lineNumber, column: Math.max(0, offset - lineStart) };
}
