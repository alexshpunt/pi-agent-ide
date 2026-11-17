import type { TextSearchMatch } from "#src/search-session.ts";

// These are safety bounds, independent of the presentation limit and fuzzy candidate budgets.
const maxCaptureBytes = 64 * 1024 * 1024;
const maxCaptureMatches = 50_000;

export class SearchCaptureLimitError extends Error {
  constructor() {
    super(
      "Search capture exceeded its safety budget. Narrow path, include/exclude globs, or the query and retry. limit only controls presentation; no complete result or edit scope was captured.",
    );
    this.name = "SearchCaptureLimitError";
  }
}

/** Account for strings as if cloned/serialized per match, even when V8 currently shares them. */
export class SearchCaptureGuard {
  private outputBytes = 0;
  private textBytes = 0;
  private matches = 0;

  addOutput(bytes: number): void {
    this.outputBytes += bytes;
    if (this.outputBytes > maxCaptureBytes) throw new SearchCaptureLimitError();
  }

  addText(characters: number): void {
    this.textBytes += characters * 2;
    if (this.textBytes > maxCaptureBytes) throw new SearchCaptureLimitError();
  }

  addMatch(match: TextSearchMatch): void {
    this.addLine(match.source);
    this.addText(match.matchedText.length + match.lineText.length + (match.linesText?.length ?? 0));
  }

  addLine(source: string): void {
    this.matches++;
    if (this.matches > maxCaptureMatches) throw new SearchCaptureLimitError();
    this.addText(source.length);
  }
}
