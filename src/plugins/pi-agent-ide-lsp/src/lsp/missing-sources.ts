import { displayFiles } from "./clang-coverage.ts";

/**
 * Whether reading a file failed because the file no longer exists. A language server's index can
 * keep places in a file that another session deleted, such as a scratch copy of a source file.
 */
export function isMissingSource(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The note for places a result leaves out because their files no longer exist. */
export function missingSourcesNotes(
  sources: readonly string[],
  display: (source: string) => string,
): string[] {
  if (sources.length === 0) return [];
  return [
    `Skipped places in deleted files that the server still indexes: ${displayFiles(sources, display)}.`,
  ];
}
