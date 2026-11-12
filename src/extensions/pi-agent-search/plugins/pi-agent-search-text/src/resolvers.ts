import path from "node:path";
import { pathToFileURL } from "node:url";
import { ResultPanel } from "pi-agent-tool-ui";
import { runScopedSearch } from "#src/scoped-search.ts";

import {
  captureCurrentMatches,
  type CaptureOptions,
  type CapturedMatches,
} from "#src/current-matches.ts";
import { searchFiles } from "#src/file-search.ts";
import type { TextSearchRequest } from "#src/search-backend.ts";
import {
  booleanQueryNotice,
  createSearchRecipe,
  runSearchRecipe,
  type SearchRecipe,
} from "#src/search-recipe.ts";
import { renderSearchResult } from "#src/search-renderer.ts";
import {
  createFuzzyPresentation,
  createSearchToolDetails,
  displaySource,
} from "#src/search-result.ts";
import { planSearchPresentation } from "#src/search-presentation.ts";

import {
  compareMatches,
  type SearchSessionStore,
  type TextSearchMatch,
  type TextSearchSession,
} from "#src/search-session.ts";
import type { SearchRequest, SearchResolver } from "pi-agent-search/api/search";
import {
  currentScope,
  selectionData,
  fuzzyLimits,
  isFuzzyQuery,
  fuzzyCandidateData,
  formatFuzzyCandidate,
  type FuzzyCandidate,
  type FuzzyResult,
} from "pi-agent-search/api/search";
import type { SearchToolDetails } from "#src/search-result.ts";
import { isWholeIdentifierMatch, searchFuzzy, searchFuzzyAlternative } from "#src/fuzzy-search.ts";

const SEARCH_ANCHOR_LEGEND =
  "Anchors: SEARCH#HASH:N:line (line), SEARCH#HASH:N:match (exact match), SEARCH#HASH:all:line (each unique containing line), SEARCH#HASH:all:match (every exact match)";
interface TextPayload {
  readonly request: SearchRequest;
  readonly matches: readonly TextSearchMatch[];
  readonly complete: boolean;
  readonly recipe: SearchRecipe;
  readonly notices: readonly string[];
  readonly fuzzy?: FuzzyResult;
}

interface FilePayload {
  readonly query: string;
  readonly files: readonly string[];
  readonly complete: boolean;
}

/** What a search registered its anchors for; a concurrent writer can make it differ from the backend's matches. */
interface RegisteredMatches {
  readonly matches: readonly TextSearchMatch[];
  readonly complete: boolean;
  readonly notices: readonly string[];
}

/**
 * The query and options that produced these matches, including the broadening step a fallback
 * used, so the same matching can run again inside the text the matches are registered with.
 */
function effectiveRequest(result: TextPayload): TextSearchRequest {
  const query = result.request.query;
  if (query === result.recipe.query) return result.recipe;
  const fallback = result.recipe.fallbacks?.find((candidate) => candidate.query === query);
  const { condition: _condition, ...options } = result.recipe;
  return fallback?.condition === undefined
    ? { ...options, query, regex: true }
    : { ...options, query, regex: true, condition: fallback.condition };
}

/**
 * A possible-name candidate's matches with the text they describe, ready to register without
 * reading its files again. Searching that text again keeps the candidate's own rules: whole
 * identifiers only, and no more matches than a candidate captures. A candidate registers all its
 * matches or none, so a source that cannot be read, or that exceeds the byte budget of `read`,
 * fails it.
 */
async function captureCandidate(
  candidate: FuzzyCandidate,
  request: TextSearchRequest,
  cwd: string,
  options: Pick<CaptureOptions, "read" | "signal">,
): Promise<CapturedMatches> {
  const captured = await captureCurrentMatches(candidate, cwd, {
    ...options,
    request,
    inContent: true,
    accept: isWholeIdentifierMatch,
    requireEverySource: true,
  });
  if (captured.matches.length <= fuzzyLimits.matchesPerCandidate) return captured;
  return {
    ...captured,
    matches: [...captured.matches].sort(compareMatches).slice(0, fuzzyLimits.matchesPerCandidate),
    complete: false,
  };
}

/** Search unhandled requests with literal-first hybrid matching. */
export function createTextResolver(
  sessions: SearchSessionStore,
  resultScopeOnly = false,
): SearchResolver {
  return createMatchResolver("text", sessions, createSearchRecipe, resultScopeOnly);
}

/** Search an explicit regex without broadening or swallowing syntax errors. */
export function createRegexResolver(
  sessions: SearchSessionStore,
  resultScopeOnly = false,
): SearchResolver {
  return createMatchResolver(
    "regex",
    sessions,
    (request) =>
      request.query.startsWith("regex:")
        ? { ...request, query: request.query.slice("regex:".length), regex: true }
        : undefined,
    resultScopeOnly,
  );
}

/** Options the `file_search` tool passes in `SearchRequest.options.files`; their presence selects this resolver. */
export interface FileSearchOptions {
  readonly pattern: string;
}

function fileOptions(request: SearchRequest): FileSearchOptions | undefined {
  const value = request.options?.files as FileSearchOptions | undefined;
  return typeof value?.pattern === "string" ? value : undefined;
}

/** Resolve file-path patterns through the local or owned file search backend. */
export function createFileResolver(): SearchResolver {
  return {
    id: "files",
    supportsPathList: true,
    readResources: (request, context) =>
      fileOptions(request) === undefined ? [] : (request.paths ?? [request.path ?? context.cwd]),
    toScriptData(payload) {
      const result = payload as FilePayload;
      return { kind: "files", files: [...result.files], complete: result.complete };
    },
    async tryResolve(request, context) {
      const options = fileOptions(request);
      if (options === undefined) return { kind: "not-handled" };

      const query = options.pattern.trim();
      const result = await searchFiles(
        query,
        request,
        context.cwd,
        context.signal,
        context.environment,
      );
      return { kind: "resolved", payload: { query, ...result } satisfies FilePayload };
    },
    renderResult(result, options, theme) {
      const data = result.details as FilePayload & { cwd: string };
      return new ResultPanel(
        {
          summary: `${data.files.length}${data.complete ? "" : "+"} ${data.files.length === 1 ? "file" : "files"}`,
          rows: data.files.length
            ? data.files.map((file) => ({
                kind: "source",
                label: file,
                link: file.startsWith("ssh://")
                  ? file
                  : pathToFileURL(path.resolve(data.cwd, file)).href,
              }))
            : [{ kind: "note", text: "No files found" }],
        },
        theme,
        options.expanded,
      );
    },
    format(payload, context) {
      const result = payload as FilePayload;
      const heading = result.complete
        ? `${String(result.files.length)} files`
        : `${String(result.files.length)}+ files (limit reached)`;
      return {
        content: [{ type: "text", text: [heading, ...result.files].join("\n") }],
        details: {
          query: result.query,
          files: result.files,
          complete: result.complete,
          cwd: context.cwd,
        },
      };
    },
  };
}

function createMatchResolver(
  id: "text" | "regex",
  sessions: SearchSessionStore,
  queryBody: (request: SearchRequest) => SearchRecipe | undefined,
  resultScopeOnly = false,
): SearchResolver {
  /**
   * What the registration made of each formatted payload. Registering can relocate or leave out
   * matches another session wrote meanwhile, so a script must be shown those matches, in their
   * order, and not the ones the backend returned: its anchors and targets belong to them.
   */
  const registered = new WeakMap<TextPayload, RegisteredMatches>();
  return {
    readResources: (request, context) =>
      queryBody(request) === undefined || (resultScopeOnly && context.scope === undefined)
        ? []
        : (context.scope?.targets.map((target) => target.source) ??
          request.paths ?? [request.path ?? context.cwd]),
    id,
    supportsResultScope: true,
    supportsPathList: true,
    supportsMultiline: true,
    toScriptData(payload, details) {
      const result = payload as TextPayload;
      const formatted = details as SearchToolDetails & {
        target?: string;
        matchTargets?: readonly string[];
      };
      const sessionId = formatted.sessionId;
      const shown = registered.get(result) ?? result;
      return {
        ...selectionData(shown.matches, shown.complete, sessionId, formatted),
        notices: [...shown.notices],
        ...(formatted.fuzzy === undefined ? {} : { fuzzy: formatted.fuzzy }),
      };
    },
    async tryResolve(request, context) {
      if (resultScopeOnly && context.scope === undefined) return { kind: "not-handled" };
      const recipe = queryBody(request);
      if (recipe === undefined) return { kind: "not-handled" };
      const result =
        context.scope === undefined
          ? await runSearchRecipe(recipe, context.cwd, context.signal, context.environment)
          : await runScopedSearch(recipe, context.scope, context.cwd, context.signal);
      const fuzzy =
        context.scope === undefined &&
        id === "text" &&
        request.multiline !== true &&
        result.complete &&
        result.matches.length === 0 &&
        isFuzzyQuery(request.query)
          ? await searchFuzzy(
              { ...request, query: request.query },
              context.cwd,
              context.signal,
              context.environment,
            )
          : undefined;
      return {
        kind: "resolved",
        payload: {
          request: { ...request, query: result.query },
          ...result,
          notices: [booleanQueryNotice(recipe) ?? [], result.notices].flat(),
          recipe: { ...recipe, originalQuery: request.query },
          ...(fuzzy === undefined ? {} : { fuzzy }),
        } satisfies TextPayload,
      };
    },
    async format(payload, context) {
      const result = payload as TextPayload;

      const scope = context.scope;
      const refresh =
        scope === undefined
          ? undefined
          : async (signal?: AbortSignal) =>
              runScopedSearch(
                result.recipe,
                (await currentScope(context, signal)) ?? scope,
                context.cwd,
                signal,
              );
      // Another session may write a matched file between the search and this registration. The
      // captured text is the snapshot, and its own matches are registered with it.
      const captured = await captureCurrentMatches(result, context.cwd, {
        request: effectiveRequest(result),
        inContent: scope === undefined,
        read: sessions.snapshotReader(context.cwd, context.environment),
        ...(refresh === undefined ? {} : { rerun: refresh }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const notices = [...result.notices, ...captured.notices];
      const session = await sessions.register(
        result.request.query,
        captured.matches,
        captured.complete,
        context.cwd,
        context.signal,
        result.recipe,
        refresh,
        undefined,
        context.environment,
        captured.contents,
      );
      registered.set(result, {
        matches: session.matches,
        complete: session.complete,
        notices,
      });
      if (result.fuzzy !== undefined) {
        const details = createSearchToolDetails(
          result.request.query,
          [],
          result.complete,
          context.cwd,
        );
        const groups = [];
        // What each candidate shows: the matches it registered, or the backend's when it could not.
        const shown: FuzzyCandidate[] = [];
        let registrationLimited = false;
        const deadline = AbortSignal.timeout(fuzzyLimits.timeoutMs);
        const registrationSignal =
          context.signal === undefined ? deadline : AbortSignal.any([context.signal, deadline]);
        for (const candidate of result.fuzzy.candidates) {
          const recipe: SearchRecipe = {
            ...result.request,
            query: candidate.identifier,
            regex: false,
            caseSensitive: true,
            wholeWord: true,
          };
          let session: TextSearchSession | undefined;
          try {
            // Another session may write a candidate file after the search, as on the main path:
            // the captured text is the snapshot, with the candidate's matches in that text.
            const captured = await captureCandidate(candidate, recipe, context.cwd, {
              read: sessions.snapshotReader(
                context.cwd,
                context.environment,
                fuzzyLimits.vocabularyBytes,
              ),
              signal: registrationSignal,
            });
            // The name is gone from every file it was found in, so it is no longer a possible name.
            if (captured.matches.length === 0) continue;
            session = await sessions.registerIfCurrent(
              candidate.identifier,
              captured.matches,
              captured.complete,
              context.cwd,
              registrationSignal,
              recipe,
              (signal) => searchFuzzyAlternative(recipe, context.cwd, signal, context.environment),
              fuzzyLimits.vocabularyBytes,
              context.environment,
              captured.contents,
            );
          } catch {
            context.signal?.throwIfAborted();
          }
          if (session === undefined) registrationLimited = true;
          const registeredCandidate =
            session === undefined
              ? candidate
              : { ...candidate, matches: session.matches, complete: session.complete };
          shown.push(registeredCandidate);
          groups.push(fuzzyCandidateData(registeredCandidate, session?.id, session));
        }
        const message = registrationLimited
          ? "Some candidate files changed or could not be registered; locations are shown without stable references."
          : result.fuzzy.message;
        const fuzzy = {
          status: result.fuzzy.status,
          ...(message === undefined ? {} : { message }),
          candidates: groups,
        };
        const rows = [...notices, "No matches found."];
        if (groups.some((candidate) => candidate.selection.matches[0]?.references !== undefined))
          rows.push(SEARCH_ANCHOR_LEGEND);
        if (fuzzy.status === "ready" && fuzzy.message !== undefined) rows.push(fuzzy.message);
        if (fuzzy.status === "skipped")
          rows.push(`Possible-name fallback skipped: ${fuzzy.message}`);
        if (groups.length > 0)
          rows.push(
            "Possible names — spelling suggestions, not equivalent behavior.",
            ...groups.map(formatFuzzyCandidate),
          );
        return {
          content: [{ type: "text", text: rows.join("\n\n") }],
          details: {
            ...details,
            ...(session.target === undefined ? {} : { target: session.target, matchTargets: [] }),
            fuzzyPresentation: createFuzzyPresentation(shown, context.cwd),
            fuzzy,
          } satisfies SearchToolDetails,
        };
      }

      const detailBudget = result.request.limit ?? 50;
      if (session.matches.length === 0) {
        return {
          content: [{ type: "text", text: [...notices, "No matches found."].join("\n") }],
          details: {
            ...createSearchToolDetails(session.query, [], session.complete, context.cwd),
            ...(session.target === undefined ? {} : { target: session.target, matchTargets: [] }),
          },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: [...notices, formatSearchSession(session, context.cwd, detailBudget)].join("\n"),
          },
        ],
        details: {
          ...createSearchToolDetails(
            session.query,
            session.matches,
            session.complete,
            context.cwd,
            session.id,
            detailBudget,
          ),
          ...(session.target === undefined
            ? {}
            : { target: session.target, matchTargets: session.matchTargets }),
        },
      };
    },
    renderResult: renderSearchResult as SearchResolver["renderResult"],
  };
}

function formatSearchSession(
  session: TextSearchSession,
  cwd: string,
  detailBudget: number,
): string {
  const fileCount = new Set(session.matches.map((match) => match.source)).size;
  const count = session.matches.length;
  const summary = `${String(count)}${session.complete ? "" : "+"} ${plural(count, "match", "matches")} in ${String(fileCount)} ${plural(fileCount, "file", "files")}`;
  const heading = session.complete
    ? `SEARCH#${session.id}:all:line / SEARCH#${session.id}:all:match — ${summary}`
    : `${summary} (incomplete results; no all anchors were registered)`;
  const lines = [SEARCH_ANCHOR_LEGEND, heading];
  const indices = new Map(session.matches.map((match, index) => [match, index + 1]));
  const presentation = planSearchPresentation(session.matches, detailBudget);

  for (const [fileIndex, file] of presentation.files.entries()) {
    if (fileIndex > 0) lines.push("");
    const source = displaySource(file.source, cwd);
    if (file.kind === "compacted") {
      lines.push(
        `${source}: ${String(file.matchCount)} matches across ${String(file.uniqueLineCount)} unique line texts (compacted)`,
      );
      for (const group of file.groups) {
        const index = indices.get(group.first);
        const first = group.first;
        lines.push(
          index === undefined
            ? `  ×${String(group.matchCount)} first at ${source}:${String(first.lineNumber)}`
            : `  ×${String(group.matchCount)} first at ${source}:${String(first.lineNumber)} SEARCH#${session.id}:${String(index)}:line SEARCH#${session.id}:${String(index)}:match`,
          `    ${previewLine(group.text)}`,
        );
      }
      if (file.groups.length < file.uniqueLineCount) {
        lines.push(
          `  … ${String(file.uniqueLineCount - file.groups.length)} more unique line texts`,
        );
      }
      lines.push(
        `  Search again with path: ${JSON.stringify(source)} and a narrower query to see individual matches.`,
      );
      continue;
    }

    for (const match of file.matches) {
      const index = indices.get(match);
      if (index === undefined) continue;
      const end =
        match.endLineNumber === undefined
          ? String(match.endColumn + 1)
          : `${String(match.endLineNumber)}:${String(match.endColumn + 1)}`;
      const location = `${source}:${String(match.lineNumber)}:${String(match.startColumn + 1)}-${end}`;
      lines.push(
        `${location} SEARCH#${session.id}:${String(index)}:line SEARCH#${session.id}:${String(index)}:match`,
        `  ${previewMatch(match)}`,
      );
    }
  }

  const omittedFiles = fileCount - presentation.files.length;
  if (omittedFiles > 0) {
    const shownMatches = presentation.files.reduce(
      (total, file) => total + (file.kind === "detailed" ? file.matches.length : file.matchCount),
      0,
    );
    lines.push(
      `\n… ${omittedFiles} more files (${count - shownMatches} matches) not displayed. Narrow path, include, or query to see them.`,
    );
  }
  return lines.join("\n");
}

function previewMatch(match: TextSearchMatch): string {
  const context = 64;
  if (match.endLineNumber !== undefined) {
    // Show the matched lines themselves, bounded; continuation lines keep the preview indent.
    const maximumLines = 8;
    const from = Math.max(0, match.startColumn - context);
    const matched = match.matchedText.replace(/\r\n/gu, "\n").split("\n");
    const shown = matched.slice(0, maximumLines);
    const more = matched.length - shown.length;
    return `${from > 0 ? "…" : ""}${match.lineText.slice(from, match.startColumn)}⟦${shown.join("\n  ")}${
      more > 0 ? `\n  … ${String(more)} more lines` : ""
    }⟧`;
  }
  const from = Math.max(0, match.startColumn - context);
  const to = Math.min(match.lineText.length, match.endColumn + context);
  return `${from > 0 ? "…" : ""}${match.lineText.slice(from, match.startColumn)}⟦${match.lineText.slice(
    match.startColumn,
    match.endColumn,
  )}⟧${match.lineText.slice(match.endColumn, to)}${to < match.lineText.length ? "…" : ""}`;
}

function previewLine(text: string): string {
  const context = 129;
  return `${text.slice(0, context)}${text.length > context ? "…" : ""}`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}
