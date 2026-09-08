import { storeText, restoreText, type StoredText } from "pi-agent-text";
import type { SearchToolDetails, SearchResultFile, SearchResultRange } from "./search-result.js";

type StoredLine = readonly [number, StoredText, readonly SearchResultRange[]];
interface StoredSearchDetails extends Omit<SearchToolDetails, "files"> {
  readonly storedFiles: readonly (Omit<SearchResultFile, "lines"> & {
    readonly lines: readonly StoredLine[];
  })[];
}

/** Uses the output without match delimiters as a stable text-reference source. */
function sourceText(text: string): string {
  return text.replaceAll("⟦", "").replaceAll("⟧", "");
}

/** Stores match geometry while sharing line text with the saved tool output. */
export function compactSearchDetails(
  details: SearchToolDetails,
  text: string,
): StoredSearchDetails {
  const { files, ...rest } = details;
  const source = sourceText(text);
  return {
    ...rest,
    storedFiles: files.map(({ lines, ...file }) => ({
      ...file,
      lines: lines.map((line): StoredLine => [
        line.lineNumber,
        storeText(line.text, source),
        line.ranges,
      ]),
    })),
  };
}

/** Restores renderer data from the result alone, including literal fallback lines. */
export function restoreSearchDetails(
  value: SearchToolDetails | StoredSearchDetails,
  text: string,
): SearchToolDetails {
  if ("files" in value) return value;
  const { storedFiles, ...rest } = value;
  const source = sourceText(text);
  return {
    ...rest,
    files: storedFiles.map(({ lines, ...file }) => ({
      ...file,
      lines: lines.map(([lineNumber, text, ranges]) => ({
        lineNumber,
        text: restoreText(text, source),
        ranges,
        matchCount: ranges.length,
      })),
    })),
  };
}
