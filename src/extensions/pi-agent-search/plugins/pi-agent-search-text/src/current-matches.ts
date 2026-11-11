import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SearchEnvironment } from "pi-agent-search/api/search";
import { createTextDocument } from "pi-agent-text";

import { searchTextContent, type TextSearchRequest } from "#src/search-backend.ts";
import { matchDescribesText, type TextSearchMatch } from "#src/search-session.ts";

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
  readonly environment?: SearchEnvironment;
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
 * that cannot be read at all is dropped with a notice, and the result becomes incomplete; a
 * capture that keeps nothing fails with the read error.
 */
export async function captureCurrentMatches(
  snapshot: { readonly matches: readonly TextSearchMatch[]; readonly complete: boolean },
  cwd: string,
  options: CaptureOptions,
): Promise<CapturedMatches> {
  let matches = snapshot.matches;
  let complete = snapshot.complete;
  for (let attempt = 1; ; attempt += 1) {
    const { contents, unreadable, failure } = await readSources(matches, options);
    const kept = matches.filter((match) => !unreadable.has(match.source));
    if (kept.length === 0 && unreadable.size > 0) throw failure;
    const notices =
      unreadable.size === 0
        ? []
        : [
            `Search notice: ${describeSources(unreadable, cwd)} could not be read while the search registered its results, because another process is writing or removing ${unreadable.size === 1 ? "it" : "them"}. Matches of ${unreadable.size === 1 ? "that file" : "those files"} are not shown; search again for them.`,
          ];
    const changed = changedSources(kept, contents);
    if (changed.size === 0)
      return { matches: kept, complete: complete && unreadable.size === 0, contents, notices };
    if (options.inContent) {
      const current = await matchesInCapturedText(kept, contents, changed, cwd, options);
      const stale = changedSources(current, contents);
      if (stale.size > 0) throw sourceChanged(stale, cwd);
      return {
        matches: current,
        complete: complete && unreadable.size === 0,
        contents,
        notices,
      };
    }
    if (options.rerun === undefined || attempt >= rerunAttempts) throw sourceChanged(changed, cwd);
    const next = await options.rerun(options.signal);
    matches = next.matches.map((match) => ({ ...match, source: canonical(match.source) }));
    complete = next.complete;
  }
}

/** Reads every matched source once; a source that cannot be read is reported, not thrown. */
async function readSources(
  matches: readonly TextSearchMatch[],
  options: CaptureOptions,
): Promise<{
  readonly contents: ReadonlyMap<string, string>;
  readonly unreadable: ReadonlySet<string>;
  readonly failure?: unknown;
}> {
  const sources = [...new Set(matches.map((match) => match.source))];
  const read = await Promise.all(
    sources.map(
      async (
        source,
      ): Promise<{ source: string; content?: string; error?: unknown; failed: boolean }> => {
        options.signal?.throwIfAborted();
        try {
          return {
            source,
            failed: false,
            content:
              options.environment === undefined
                ? await readFile(source, {
                    encoding: "utf8",
                    ...(options.signal !== undefined && { signal: options.signal }),
                  })
                : await options.environment.readText(source, options.signal),
          };
        } catch (error) {
          options.signal?.throwIfAborted();
          return { source, failed: true, error };
        }
      },
    ),
  );
  const contents = new Map<string, string>();
  const unreadable = new Set<string>();
  let failure: unknown;
  for (const entry of read) {
    if (!entry.failed) {
      contents.set(entry.source, entry.content ?? "");
      continue;
    }
    unreadable.add(entry.source);
    failure ??= entry.error;
  }
  return { contents, unreadable, ...(failure === undefined ? {} : { failure }) };
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
    for (const match of found.matches)
      current.push({
        ...match,
        source,
        lineText: document.lines[match.lineNumber - 1]?.content ?? match.lineText,
      });
  }
  return current.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.lineNumber - right.lineNumber ||
      left.startColumn - right.startColumn ||
      (left.endLineNumber ?? left.lineNumber) - (right.endLineNumber ?? right.lineNumber) ||
      left.endColumn - right.endColumn,
  );
}

function sourceChanged(sources: ReadonlySet<string>, cwd: string): Error {
  return new Error(
    `${describeSources(sources, cwd)} kept changing while the search registered its results, because another process is writing ${sources.size === 1 ? "it" : "them"}. Repeat the search and use its new anchors.`,
  );
}

function describeSources(sources: ReadonlySet<string>, cwd: string): string {
  const shown = [...sources].slice(0, 3).map((source) => display(source, cwd));
  const rest = sources.size - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${String(rest)} more` : shown.join(", ");
}

function display(source: string, cwd: string): string {
  if (source.includes("://") || cwd.includes("://")) return source;
  const relative = path.relative(cwd, source);
  // oxlint-disable-next-line repo/no-parent-paths -- display only, never used as a path
  return relative.startsWith("..") || path.isAbsolute(relative) ? source : relative;
}

function canonical(source: string): string {
  return source.includes("://") ? source : path.resolve(source);
}
