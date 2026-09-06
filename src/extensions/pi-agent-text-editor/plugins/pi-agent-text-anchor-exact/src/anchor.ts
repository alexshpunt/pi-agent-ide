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

import type { ExactTextRecoveryConfig } from "./config.js";
import { recoverExactText } from "./recovery.js";

interface NormalizedText {
  readonly text: string;
  readonly boundaries: readonly number[];
}

/** Creates the catch-all resolver for unique exact text spans. */
export function createExactTextAnchorResolver(config: ExactTextRecoveryConfig): TextAnchorResolver {
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
      return Promise.resolve(resolveExactTextAnchor(value, context));
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
  const startOffset = bomOffset + boundaryAt(source.boundaries, normalizedStart);
  const endOffset = bomOffset + boundaryAt(source.boundaries, normalizedStart + query.length);

  const linewise = isWholeLineMatch(context.content, startOffset, endOffset);
  const selectionEndOffset = linewise
    ? includeTrailingLineBreak(context.content, endOffset)
    : endOffset;
  const range = {
    start: positionAt(context.content, startOffset),
    end: positionAt(context.content, selectionEndOffset),
    ...(linewise && { linewise: true }),
  };
  return {
    kind: "resolved",
    anchor: new TextSelectionAnchor(value, context.source, [range]),
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
      start: positionAt(context.content, bomOffset + boundaryAt(source.boundaries, start)),
      end: positionAt(
        context.content,
        bomOffset + boundaryAt(source.boundaries, start + query.length),
      ),
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
  const characters: string[] = [];
  const boundaries: number[] = [0];

  for (let offset = 0; offset < value.length; offset += 1) {
    const character = value[offset];
    if (character === "\r") {
      const width = value[offset + 1] === "\n" ? 2 : 1;
      characters.push("\n");
      offset += width - 1;
      boundaries.push(offset + 1);
      continue;
    }

    characters.push(character ?? "");
    boundaries.push(offset + 1);
  }

  return { text: characters.join(""), boundaries };
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

function boundaryAt(boundaries: readonly number[], index: number): number {
  const boundary = boundaries[index];
  if (boundary === undefined) {
    throw new RangeError("Exact text match is outside normalized source boundaries");
  }
  return boundary;
}

function positionAt(content: string, offset: number): TextSelectionPosition {
  let lineNumber = 1;
  let column = 0;
  for (let index = 0; index < offset; index += 1) {
    const character = content[index];
    if (character === "\r") {
      if (content[index + 1] === "\n") {
        index += 1;
      }
      lineNumber += 1;
      column = 0;
    } else if (character === "\n") {
      lineNumber += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { lineNumber, column };
}
