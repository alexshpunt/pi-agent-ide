import { createTextDocument, documentLineAnchors } from "pi-agent-text";
import { NO_FINAL_LINE_BREAK } from "pi-agent-text-editor/api/mutation-result";
import { normalizeToLF, splitBom } from "pi-agent-text-editor/api/pi-edit-text";

import type { BoundLiteralMatcher, LiteralMatcher, LiteralSpan } from "./literal-match.ts";

interface View {
  readonly text: string;
  toSource(span: LiteralSpan, queryLines: readonly string[]): LiteralSpan | undefined;
}

/** The current Read anchors view, built only after ordinary literal matching fails. */
export class AnchoredLiteralView {
  private view: View | undefined;
  private viewWithBom: View | undefined;

  constructor(
    private readonly source: string,
    private readonly content: string,
  ) {}

  *matchers(value: string, matchers: readonly LiteralMatcher[]): Iterable<BoundLiteralMatcher> {
    const withoutLastBreak = value.replace(/\r?\n$/u, "");
    const marker = `\n${NO_FINAL_LINE_BREAK}`;
    const hasMarker = withoutLastBreak.endsWith(marker);
    if (hasMarker && this.content.endsWith("\n")) return;
    const beforeMarker = withoutLastBreak.slice(0, -marker.length);
    const query = hasMarker ? beforeMarker.replace(/\r$/u, "") : value;
    // A copied slice must cross a pipe, or stop partway through a later row's anchor.
    if (!query.includes("|") && !/\n[0-9A-HJKMNP-TV-Z]{1,7}\s*$/u.test(query)) return;
    const keepBom = splitBom(query).text.includes("\uFEFF");
    const view = keepBom
      ? (this.viewWithBom ??= createView(this.source, this.content, true))
      : (this.view ??= createView(this.source, this.content, false));
    const queryLines = normalizeToLF(splitBom(query).text).split("\n");
    for (const matcher of matchers) {
      yield (accept, limit) => {
        const spans: LiteralSpan[] = [];
        matcher.find(
          view.text,
          query,
          (span) => {
            const mapped = view.toSource(span, queryLines);
            if (
              mapped === undefined ||
              (hasMarker && mapped.to !== this.content.length) ||
              !accept(mapped)
            )
              return false;
            spans.push(mapped);
            return true;
          },
          limit,
        );
        return spans;
      };
    }
  }
}

function createView(source: string, content: string, keepBom: boolean): View {
  const { lines } = createTextDocument(source, content);
  const anchors = documentLineAnchors(lines);
  const prefixWidth = (anchors[0]?.length ?? 0) + 1;
  const bomWidth = keepBom ? 0 : splitBom(content).bom.length;
  const starts: number[] = [];
  let offset = 0;
  const text = lines
    .map((line, index) => {
      starts.push(offset);
      const row = `${anchors[index]}|${line.content.slice(index === 0 ? bomWidth : 0)}${line.lineEnding}`;
      offset += row.length;
      return row;
    })
    .join("");

  function rowAt(at: number): number {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if ((starts[middle] ?? Infinity) <= at) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  function sourceOffset(at: number, row: number): number {
    // Everything inside a prefix maps to its line's content boundary.
    return Math.max(at, (starts[row] ?? 0) + prefixWidth) - (row + 1) * prefixWidth + bomWidth;
  }

  return {
    text,
    toSource(span, queryLines) {
      const firstRow = rowAt(span.from);
      const lastRow = rowAt(span.to);
      let touchedPrefix = false;
      let copiedRow = 0;
      for (let row = firstRow; row <= lastRow; row++) {
        const start = starts[row] ?? 0;
        const from = Math.max(start, span.from);
        const to = Math.min(start + prefixWidth, span.to);
        if (from < to) {
          // Fuzzy normalization must never turn a lookalike into a current hash or pipe.
          if (!queryLines[copiedRow]?.startsWith(text.slice(from, to))) return undefined;
          touchedPrefix = true;
        }
        const nextStart = starts[row + 1];
        if (nextStart !== undefined && nextStart < span.to) {
          // Read only splits on LF. Pi's tolerant matchers treat embedded CR as another break.
          copiedRow += normalizeToLF(text.slice(from, nextStart)).split("\n").length - 1;
        }
      }
      if (!touchedPrefix) return undefined;
      const from = sourceOffset(span.from, firstRow);
      const to = sourceOffset(span.to, lastRow);
      // A prefix alone is not a text span; standalone anchors have their own resolver.
      return from < to ? { from, to } : undefined;
    },
  };
}
