import {
  createTextDocument,
  textLineAnchors,
  type TextAnchorRecoveryCandidateRange,
} from "pi-agent-text";

/** How many matches an ambiguity refusal lists. */
const SHOWN_CANDIDATES = 5;
const CONTEXT_LINES = 1;
const MAX_LINE_LENGTH = 120;

/** Fields whose boundary is the end of the match; the others take its first line. */
const END_FIELDS = new Set(["through", "after", "targetThrough", "targetAfter"]);
/** The second boundary of a pair: its matches are listed from the first boundary on. */
const SECOND_BOUNDARY_FIELDS = new Set(["through", "before", "targetThrough", "targetBefore"]);
/** A lone selector of a whole span: a multi-line match needs a from/through pair instead. */
const SPAN_FIELDS: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["at", ["from", "through"]],
  ["targetAt", ["targetFrom", "targetThrough"]],
]);

export interface AmbiguousCandidates {
  readonly field: string;
  readonly source: string;
  readonly content: string;
  /** The matches in file order; for a second boundary that is nearest to the first one first. */
  readonly candidates: readonly TextAnchorRecoveryCandidateRange[];
  readonly total: number;
}

/**
 * The matches of an ambiguous selector: for each its line number, line anchor and the lines around
 * it, then one call that selects the first match by its anchor in the same field. The tool never
 * picks among the matches; the next call does.
 */
export function formatAmbiguousCandidates(options: AmbiguousCandidates): string {
  const { field, source, content, candidates, total } = options;
  const lines = createTextDocument(source, content).lines;
  const anchors = textLineAnchors(source, content);
  const shown = candidates.slice(0, SHOWN_CANDIDATES).map((range) => {
    const first = range.start.lineNumber;
    const last = Math.max(
      first,
      range.end.column === 0 && range.end.lineNumber > first
        ? range.end.lineNumber - 1
        : range.end.lineNumber,
    );
    return { first, last };
  });
  const width = String(Math.min(lines.length, (shown.at(-1)?.last ?? 1) + CONTEXT_LINES)).length;
  const row = (number: number, marker: string) =>
    `${marker}${String(number).padStart(width)}| ${truncate(lines[number - 1]?.content ?? "")}`;

  const blocks = shown.map(({ first, last }, index) => {
    const rows: string[] = [];
    for (
      let number = Math.max(1, first - CONTEXT_LINES);
      number <= Math.min(lines.length, last + CONTEXT_LINES);
      number++
    )
      rows.push(row(number, number >= first && number <= last ? "> " : "  "));
    const place =
      first === last
        ? `line ${first}, anchor ${anchors[first - 1] ?? ""}`
        : `lines ${first}-${last}, anchors ${anchors[first - 1] ?? ""} to ${anchors[last - 1] ?? ""}`;
    return `${index + 1}. ${place}\n${rows.join("\n")}`;
  });

  const head = shown[0];
  const example = head === undefined ? "" : exampleCall(field, head, anchors);
  const more = total > shown.length ? `\n… ${total - shown.length} more matches.` : "";
  const order = SECOND_BOUNDARY_FIELDS.has(field) ? ", nearest to the start selector first" : "";
  return `Matches${order}:\n${blocks.join("\n")}${more}\n\nExample: ${example}`;
}

function exampleCall(
  field: string,
  { first, last }: { readonly first: number; readonly last: number },
  anchors: readonly string[],
): string {
  const firstAnchor = anchors[first - 1] ?? "";
  const lastAnchor = anchors[last - 1] ?? "";
  const span = SPAN_FIELDS.get(field);
  if (span !== undefined && first !== last)
    return `${span[0]}: "${firstAnchor}", ${span[1]}: "${lastAnchor}"`;
  return `${field}: "${END_FIELDS.has(field) ? lastAnchor : firstAnchor}"`;
}

function truncate(text: string): string {
  const line = text.replace(/\r$/u, "");
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
}
