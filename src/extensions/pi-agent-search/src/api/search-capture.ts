import type { SearchSelectionMatch } from "./search.ts";

// These are safety bounds, independent of the presentation limit and fuzzy candidate budgets.
const maxCaptureBytes = 64 * 1024 * 1024;
const maxCaptureMatches = 50_000;

/** A search found more than one call may capture; no complete result or edit scope exists. */
export class SearchCaptureLimitError extends Error {
  /** `query` names what the caller can narrow besides the path and globs, such as a pattern. */
  constructor(query = "the query") {
    super(
      `Search capture exceeded its safety budget. Narrow path, include/exclude globs, or ${query} and retry. limit only controls presentation; no complete result or edit scope was captured.`,
    );
    this.name = "SearchCaptureLimitError";
  }
}

/** The text a guard accounts for in one match. */
export type CapturedSearchMatch = Pick<
  SearchSelectionMatch,
  "source" | "matchedText" | "lineText" | "linesText"
>;

/**
 * Bounds what one search call captures: backend output bytes, match count and retained text.
 * Accounts for strings as if cloned/serialized per match, even when V8 currently shares them.
 */
export class SearchCaptureGuard {
  private outputBytes = 0;
  private textBytes = 0;
  private matches = 0;

  /** `query` names what the caller can narrow in the budget error, such as "the pattern". */
  constructor(private readonly query?: string) {}

  addOutput(bytes: number): void {
    this.outputBytes += bytes;
    if (this.outputBytes > maxCaptureBytes) throw new SearchCaptureLimitError(this.query);
  }

  addText(characters: number): void {
    this.textBytes += characters * 2;
    if (this.textBytes > maxCaptureBytes) throw new SearchCaptureLimitError(this.query);
  }

  addMatch(match: CapturedSearchMatch): void {
    this.addLine(match.source);
    this.addText(match.matchedText.length + match.lineText.length + (match.linesText?.length ?? 0));
  }

  addLine(source: string): void {
    this.matches++;
    if (this.matches > maxCaptureMatches) throw new SearchCaptureLimitError(this.query);
    this.addText(source.length);
  }
}
