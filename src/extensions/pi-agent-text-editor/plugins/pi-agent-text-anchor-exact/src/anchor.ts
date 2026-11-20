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

import { quoteAnchorExcerpt } from "pi-agent-text-editor/api/anchor-excerpt";
import { AnchoredLiteralView } from "./anchored-literal-view.ts";
import type { ExactTextRecoveryConfig } from "./config.ts";
import { literalCandidates, matchLiteral, type LiteralSpan } from "./literal-match.ts";
import { recoverExactText } from "./recovery.ts";

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

/**
 * Resolves the one place the literal `value` selects, matching the way Pi's edit matches
 * `oldText`: exact characters first, then without the BOM and with CRLF and CR as LF, then
 * fuzzily. Finally, match a copy from the current Read anchors view. The first way that finds
 * the literal decides; more than one match is refused.
 */
export function resolveExactTextAnchor(
  value: string,
  context: TextAnchorResolverContext,
): TextAnchorResolutionAttempt {
  if (value.length === 0) {
    return rejected("invalid", "exact text anchor must be non-empty");
  }

  const content = context.content;
  const inScope = scopeFilter(context);
  const anchored = new AnchoredLiteralView(context.source, content);
  const match = matchLiteral(content, value, anchored, inScope);

  if (match.kind === "missing") {
    const outsideScope =
      inScope !== undefined && matchLiteral(content, value, anchored).kind !== "missing";
    // Interpret only single backslash control escapes, and only to explain a refusal.
    // Never resolve or edit the decoded candidate, or reinterpret escaped backslashes.
    const decoded = value.replace(/(?<!\\)\\[nrt]/gu, (escape) =>
      escape === "\\n" ? "\n" : escape === "\\r" ? "\r" : "\t",
    );
    if (
      !outsideScope &&
      decoded !== value &&
      matchLiteral(content, decoded, anchored, inScope).kind !== "missing"
    ) {
      return rejected(
        "missing",
        `Exact-text selector ${quoteAnchorExcerpt(value)} contains literal backslash escapes; the character form ${quoteAnchorExcerpt(decoded)} matches text inside the ${inScope === undefined ? "file" : "selection"}. Pass actual newline, carriage-return and tab characters in exact-text selectors, not literal backslash escapes. No decoding or edit was applied.`,
      );
    }
    return rejected(
      outsideScope ? "outside-scope" : "missing",
      inScope === undefined
        ? "exact text anchor was not found"
        : "exact text anchor was not found inside the selection",
    );
  }

  if (match.kind === "ambiguous") {
    return rejected(
      "ambiguous",
      inScope === undefined
        ? "exact text anchor matched more than once"
        : "exact text anchor matched more than once inside the selection",
    );
  }

  // Literal text selects exactly the characters it matched, even when they form complete lines.
  return {
    kind: "resolved",
    anchor: new TextSelectionAnchor(value, context.source, [
      { start: positionAt(content, match.span.from), end: positionAt(content, match.span.to) },
    ]),
  };
}

/** Finds the matches of the literal and returns their source positions. */
export function findExactTextMatches(
  value: string,
  context: TextAnchorResolverContext,
  limit: number,
): {
  readonly ranges: readonly TextAnchorRecoveryCandidateRange[];
  readonly total: number;
  readonly allMatches?: readonly TextAnchorRecoveryCandidateRange[];
} {
  const { content, source } = context;
  const spans = literalCandidates(
    content,
    value,
    new AnchoredLiteralView(source, content),
    scopeFilter(context),
  );
  const disjoint =
    spans.length > 1 &&
    spans.every(({ from, to }, index) => from < to && (spans[index - 1]?.to ?? 0) <= from);
  // For a disjoint selection, both endpoints progress in source order. Walk the lines once,
  // even when there are many more matches than will be shown.
  let lineStart = 0;
  let lineNumber = 1;
  let nextBreak = content.indexOf("\n");
  const orderedPosition = (offset: number): TextSelectionPosition => {
    while (nextBreak !== -1 && nextBreak < offset) {
      lineStart = nextBreak + 1;
      lineNumber++;
      nextBreak = content.indexOf("\n", lineStart);
    }
    return { lineNumber, column: offset - lineStart };
  };
  const allMatches = disjoint
    ? spans.map(({ from, to }) => ({
        start: orderedPosition(from),
        end: orderedPosition(to),
      }))
    : undefined;
  return {
    total: spans.length,
    ranges:
      allMatches?.slice(0, limit) ??
      spans.slice(0, limit).map(({ from, to }) => ({
        start: positionAt(content, from),
        end: positionAt(content, to),
      })),
    ...(allMatches !== undefined && { allMatches }),
  };
}

/** Only spans wholly inside one selected range count for matching and recovery. */
function scopeFilter(
  context: TextAnchorResolverContext,
): ((span: LiteralSpan) => boolean) | undefined {
  const scope = context.scope?.map((range) => scopeOffsets(context.content, range));
  return scope === undefined
    ? undefined
    : (span) => scope.some((range) => span.from >= range.from && span.to <= range.to);
}

function rejected(
  code: "invalid" | "missing" | "ambiguous" | "outside-scope",
  reason: string,
): TextAnchorResolutionAttempt {
  return { kind: "rejected", rejection: { code, reason } };
}

/**
 * Source offsets of a scope range. A range that ends at the end of a line also covers that line's
 * LF, or the CRLF when it stops before a CRLF line's CR, so text that ends with the break still
 * counts as inside. A lone CR is ordinary text.
 */
function scopeOffsets(
  content: string,
  range: TextAnchorRecoveryCandidateRange,
): { readonly from: number; readonly to: number } {
  const to = offsetAt(content, range.end);
  const lineBreak = content.startsWith("\r\n", to) ? 2 : content[to] === "\n" ? 1 : 0;
  return { from: offsetAt(content, range.start), to: to + lineBreak };
}

/** The offset of a position. Only LF ends a line; CR is an ordinary character. */
function offsetAt(content: string, position: TextSelectionPosition): number {
  let offset = 0;
  for (let line = 1; line < position.lineNumber; line++) {
    const next = content.indexOf("\n", offset);
    if (next === -1) return content.length;
    offset = next + 1;
  }
  return Math.min(content.length, offset + position.column);
}

/** The position of an offset. Only LF ends a line; CR is an ordinary character. */
function positionAt(content: string, offset: number): TextSelectionPosition {
  let lineNumber = 1;
  let lineStart = 0;
  for (
    let lineBreak = content.indexOf("\n");
    lineBreak !== -1 && lineBreak < offset;
    lineBreak = content.indexOf("\n", lineStart)
  ) {
    lineStart = lineBreak + 1;
    lineNumber += 1;
  }
  return { lineNumber, column: offset - lineStart };
}
