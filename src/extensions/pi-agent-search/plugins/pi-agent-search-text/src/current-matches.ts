import { createTextDocument, type TextDocument } from "pi-agent-text";

import { searchTextContent, type TextSearchRequest } from "#src/search-backend.ts";
import { displaySource } from "#src/search-result.ts";
import { canonicalSource, matchDescribesText, type TextSearchMatch } from "#src/search-session.ts";

/** Matches with the text they describe, ready to register without reading the files again. */
export interface CapturedMatches {
  readonly matches: readonly TextSearchMatch[];
  readonly complete: boolean;
  /** Text of every source the matches were captured from, by canonical source. */
  readonly contents: ReadonlyMap<string, string>;
  readonly notices: readonly string[];
}

export interface CaptureOptions {
  /**
   * The query and matching options that produced the matches, so a source another process wrote
   * meanwhile can be matched again inside the text this capture read.
   */
  readonly request: TextSearchRequest;
  /**
   * Search the captured text again when it no longer holds the backend's matches. A scoped search
   * must not, because the whole text is wider than its scope: it searches again instead.
   */
  readonly inContent: boolean;
  /** Run the backend search again; used when the captured text cannot be matched again. */
  readonly rerun?: (signal?: AbortSignal) => Promise<{
    readonly matches: readonly TextSearchMatch[];
    readonly complete: boolean;
  }>;
  /**
   * Keeps only the matches the backend itself would keep when the captured text is searched
   * again; a backend that filters ripgrep's matches passes the same filter.
   */
  readonly accept?: (match: TextSearchMatch) => boolean;
  /**
   * Fail when a source cannot be read instead of leaving its matches out. For a result whose
   * matches must be registered together or not at all.
   */
  readonly requireEverySource?: boolean;
  /** Reads a source the way the registration snapshot does; see `SearchSessionStore.snapshotReader`. */
  readonly read: (source: string, signal?: AbortSignal) => Promise<string>;
  readonly signal?: AbortSignal;
}

/** Attempts of a scoped search, which cannot match the captured text again. */
const rerunAttempts = 3;

/**
 * Captures the text of every matched source and returns matches that describe exactly that text,
 * so registering them needs no second read that another writer could change in between.
 *
 * Another session may write a searched file between the backend search and this capture: the
 * matches then hold old line numbers, or old text. Such a source is searched again inside the
 * text this capture read, which gives the matches a search of that text would find. A source
 * that cannot be read at all is dropped with a notice naming the reason, and the result becomes
 * incomplete; a capture that keeps nothing fails, naming the sources and that reason.
 */
export async function captureCurrentMatches(
  snapshot: { readonly matches: readonly TextSearchMatch[]; readonly complete: boolean },
  cwd: string,
  options: CaptureOptions,
): Promise<CapturedMatches> {
  let matches = snapshot.matches;
  let complete = snapshot.complete;
  for (let attempt = 1; ; attempt += 1) {
    const { contents, unreadable } = await readSources(matches, options);
    const kept = matches.filter((match) => !unreadable.has(match.source));
    if (unreadable.size > 0 && (kept.length === 0 || options.requireEverySource === true))
      throw unreadableSources(unreadable, cwd);
    // A source left out can hold matches of its own, so the result no longer covers the search.
    const covered = complete && unreadable.size === 0;
    const notices = unreadableNotices(unreadable, cwd);
    const changed = changedSources(kept, contents);
    if (changed.size === 0) return { matches: kept, complete: covered, contents, notices };
    if (options.inContent) {
      const current = await matchesInCapturedText(kept, contents, changed, cwd, options);
      const stale = changedSources(current, contents);
      if (stale.size > 0) throw notDescribed(stale, cwd);
      return { matches: current, complete: covered, contents, notices };
    }
    if (options.rerun === undefined || attempt >= rerunAttempts) throw sourceChanged(changed, cwd);
    const next = await options.rerun(options.signal);
    matches = next.matches.map((match) => ({
      ...match,
      source: canonicalSource(match.source),
    }));
    complete = next.complete;
  }
}

/** Reads every matched source once; a source that cannot be read is reported with its error. */
async function readSources(
  matches: readonly TextSearchMatch[],
  options: CaptureOptions,
): Promise<{
  readonly contents: ReadonlyMap<string, string>;
  /** The error each unreadable source gave, by source. */
  readonly unreadable: ReadonlyMap<string, unknown>;
}> {
  const sources = [...new Set(matches.map((match) => match.source))];
  const read = await Promise.all(
    sources.map(
      async (
        source,
      ): Promise<{ source: string; content?: string; error?: unknown; failed: boolean }> => {
        options.signal?.throwIfAborted();
        try {
          return { source, failed: false, content: await options.read(source, options.signal) };
        } catch (error) {
          options.signal?.throwIfAborted();
          return { source, failed: true, error };
        }
      },
    ),
  );
  const contents = new Map<string, string>();
  const unreadable = new Map<string, unknown>();
  for (const entry of read) {
    if (entry.failed) unreadable.set(entry.source, entry.error);
    else contents.set(entry.source, entry.content ?? "");
  }
  return { contents, unreadable };
}

/** Sources whose matches no longer describe the captured text. */
function changedSources(
  matches: readonly TextSearchMatch[],
  contents: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const changed = new Set<string>();
  const documents = new Map<string, ReturnType<typeof createTextDocument>>();
  for (const match of matches) {
    if (changed.has(match.source)) continue;
    const content = contents.get(match.source);
    if (content === undefined) {
      changed.add(match.source);
      continue;
    }
    let document = documents.get(match.source);
    if (document === undefined) {
      document = createTextDocument(match.source, content);
      documents.set(match.source, document);
    }
    if (!matchDescribesText(document, match)) changed.add(match.source);
  }
  return changed;
}

/** Matches of every changed source as a search of the captured text finds them. */
async function matchesInCapturedText(
  matches: readonly TextSearchMatch[],
  contents: ReadonlyMap<string, string>,
  changed: ReadonlySet<string>,
  cwd: string,
  options: CaptureOptions,
): Promise<readonly TextSearchMatch[]> {
  const current = matches.filter((match) => !changed.has(match.source));
  // Ripgrep searches the captured text itself, so a remote source needs no local path.
  const searchCwd = cwd.includes("://") ? process.cwd() : cwd;
  for (const source of changed) {
    options.signal?.throwIfAborted();
    const content = contents.get(source);
    if (content === undefined) continue;
    const found = await searchTextContent(options.request, content, searchCwd, options.signal);
    const document = createTextDocument(source, content);
    const searchedLines = lineFeedStarts(content);
    const documentLines = documentStarts(document);
    for (const match of found.matches) {
      if (options.accept?.(match) === false) continue;
      current.push(
        inDocument(
          source,
          document,
          documentLines,
          content,
          (searchedLines[match.lineNumber - 1] ?? 0) + match.startColumn,
          (searchedLines[(match.endLineNumber ?? match.lineNumber) - 1] ?? 0) + match.endColumn,
        ),
      );
    }
  }
  // Unordered: the registration sorts the matches it stores.
  return current;
}

/**
 * A match of the captured text, placed on the lines the registration splits that text into.
 *
 * Ripgrep ends a line at a line feed; a text document also ends one at a lone carriage return,
 * which a file can hold anywhere. Describing a found match by its position in the text, instead
 * of by the line ripgrep counted, keeps the two from disagreeing about such a file.
 */
function inDocument(
  source: string,
  document: TextDocument,
  starts: readonly number[],
  content: string,
  from: number,
  to: number,
): TextSearchMatch {
  const start = positionAt(starts, from);
  const end = positionAt(starts, to);
  return {
    source,
    lineNumber: start.lineNumber,
    startColumn: start.column,
    ...(end.lineNumber === start.lineNumber ? {} : { endLineNumber: end.lineNumber }),
    endColumn: end.column,
    matchedText: content.slice(from, to),
    lineText: document.lines[start.lineNumber - 1]?.content ?? "",
  };
}

/** Offset each line-feed-separated line starts at, as ripgrep counts the lines of this text. */
function lineFeedStarts(content: string): number[] {
  const starts = [0];
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1))
    starts.push(index + 1);
  return starts;
}

/** Offset each document line starts at. */
function documentStarts(document: TextDocument): number[] {
  const starts = [0];
  for (const line of document.lines)
    starts.push((starts.at(-1) ?? 0) + line.content.length + line.lineEnding.length);
  return starts;
}

/** The line and column an offset falls on, with lines numbered from 1. */
function positionAt(
  starts: readonly number[],
  offset: number,
): { readonly lineNumber: number; readonly column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return { lineNumber: low + 1, column: offset - (starts[low] ?? 0) };
}

/** One notice per source the capture could not read, each with the reason its read gave. */
function unreadableNotices(unreadable: ReadonlyMap<string, unknown>, cwd: string): string[] {
  const shown = [...unreadable].slice(0, 3);
  const notices = shown.map(
    ([source, error]) =>
      `Search notice: ${displaySource(source, cwd)} could not be read while the search registered its results: ${reason(error)}. Its matches are not shown; search again for it once it can be read.`,
  );
  const rest = unreadable.size - shown.length;
  if (rest > 0)
    notices.push(
      `Search notice: ${String(rest)} more matched ${rest === 1 ? "file" : "files"} could not be read either, and ${rest === 1 ? "its" : "their"} matches are not shown.`,
    );
  return notices;
}

/** Nothing is left to register: name the sources and the reason the first read gave. */
function unreadableSources(unreadable: ReadonlyMap<string, unknown>, cwd: string): Error {
  const first = [...unreadable.values()][0];
  return new Error(
    `${describeSources([...unreadable.keys()], cwd)} could not be read while the search registered its results: ${reason(first)}. Repeat the search once ${unreadable.size === 1 ? "it" : "they"} can be read.`,
    { cause: first },
  );
}

function sourceChanged(sources: ReadonlySet<string>, cwd: string): Error {
  return new Error(
    `${describeSources([...sources], cwd)} kept changing while the search registered its results, because another process is writing ${sources.size === 1 ? "it" : "them"}. Repeat the search and use its new anchors.`,
  );
}

/** The matches found in the captured text do not describe it; no anchors can be registered. */
function notDescribed(sources: ReadonlySet<string>, cwd: string): Error {
  return new Error(
    `The matches in ${describeSources([...sources], cwd)} could not be placed in the text the search read, so no anchors were registered. Read the file and edit it by its own text.`,
  );
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeSources(sources: readonly string[], cwd: string): string {
  const shown = sources.slice(0, 3).map((source) => displaySource(source, cwd));
  const rest = sources.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${String(rest)} more` : shown.join(", ");
}
