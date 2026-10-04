import path from "node:path";
import { pathToFileURL } from "node:url";
import { ResultPanel } from "pi-agent-tool-ui";
import { runScopedSearch } from "#src/scoped-search.js";

import { searchFiles } from "#src/file-search.js";
import { createSearchRecipe, runSearchRecipe, type SearchRecipe } from "#src/search-recipe.js";
import { renderSearchResult } from "#src/search-renderer.js";
import { createFuzzyPresentation, createSearchToolDetails } from "#src/search-result.js";
import { planSearchPresentation } from "#src/search-presentation.js";

import type {
  SearchSessionStore,
  TextSearchMatch,
  TextSearchSession,
} from "#src/search-session.js";
import type { SearchRequest, SearchResolver } from "pi-agent-search/api/search";
import {
  selectionData,
  fuzzyLimits,
  isFuzzyQuery,
  fuzzyCandidateData,
  formatFuzzyCandidate,
  type FuzzyResult,
} from "pi-agent-search/api/search";
import type { SearchToolDetails } from "#src/search-result.js";
import { searchFuzzy, searchFuzzyAlternative } from "#src/fuzzy-search.js";

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

/** Search unhandled requests with literal-first hybrid matching. */
export function createTextResolver(sessions: SearchSessionStore): SearchResolver {
  return createMatchResolver("text", sessions, createSearchRecipe);
}

/** Search an explicit regex without broadening or swallowing syntax errors. */
export function createRegexResolver(sessions: SearchSessionStore): SearchResolver {
  return createMatchResolver("regex", sessions, (request) =>
    request.query.startsWith("regex:")
      ? { ...request, query: request.query.slice("regex:".length), regex: true }
      : undefined,
  );
}

/** Resolve file-pattern queries through the local file search backend. */
export function createFileResolver(): SearchResolver {
  return {
    id: "files",
    readResources: (request, context) =>
      request.query.startsWith("files:") ? [request.path ?? context.cwd] : [],
    toScriptData(payload) {
      const result = payload as FilePayload;
      return { kind: "files", files: [...result.files], complete: result.complete };
    },
    async tryResolve(request, context) {
      if (!request.query.startsWith("files:")) {
        return { kind: "not-handled" };
      }

      const query = request.query.slice("files:".length).trim();
      const result = await searchFiles(query, request, context.cwd, context.signal);
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
                link: pathToFileURL(path.resolve(data.cwd, file)).href,
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
): SearchResolver {
  return {
    readResources: (request, context) =>
      queryBody(request) === undefined
        ? []
        : (context.scope?.targets.map((target) => target.source) ?? [request.path ?? context.cwd]),
    id,
    supportsResultScope: true,
    toScriptData(payload, details) {
      const result = payload as TextPayload;
      const formatted = details as SearchToolDetails & {
        target?: string;
        matchTargets?: readonly string[];
      };
      const sessionId = formatted.sessionId;
      return {
        ...selectionData(result.matches, result.complete, sessionId, formatted),
        notices: [...result.notices],
        ...(formatted.fuzzy === undefined ? {} : { fuzzy: formatted.fuzzy }),
      };
    },
    async tryResolve(request, context) {
      const recipe = queryBody(request);
      if (recipe === undefined) return { kind: "not-handled" };
      const result =
        context.scope === undefined
          ? await runSearchRecipe(recipe, context.cwd, context.signal)
          : await runScopedSearch(recipe, context.scope, context.cwd, context.signal);
      const fuzzy =
        context.scope === undefined &&
        id === "text" &&
        result.complete &&
        result.matches.length === 0 &&
        isFuzzyQuery(request.query)
          ? await searchFuzzy({ ...request, query: request.query }, context.cwd, context.signal)
          : undefined;
      return {
        kind: "resolved",
        payload: {
          request: { ...request, query: result.query },
          ...result,
          recipe: { ...recipe, originalQuery: request.query },
          ...(fuzzy === undefined ? {} : { fuzzy }),
        } satisfies TextPayload,
      };
    },
    async format(payload, context) {
      const result = payload as TextPayload;

      const scope = context.scope;
      const session = await sessions.registerIfCurrent(
        result.request.query,
        result.matches,
        result.complete,
        context.cwd,
        context.signal,
        result.recipe,
        scope === undefined
          ? undefined
          : (signal) => runScopedSearch(result.recipe, scope, context.cwd, signal),
      );
      if (result.fuzzy !== undefined) {
        const details = createSearchToolDetails(
          result.request.query,
          [],
          result.complete,
          context.cwd,
        );
        const groups = [];
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
            session = await sessions.registerIfCurrent(
              candidate.identifier,
              candidate.matches,
              candidate.complete,
              context.cwd,
              registrationSignal,
              recipe,
              (signal) => searchFuzzyAlternative(recipe, context.cwd, signal),
              fuzzyLimits.vocabularyBytes,
            );
          } catch {
            context.signal?.throwIfAborted();
          }
          if (session === undefined) registrationLimited = true;
          groups.push(fuzzyCandidateData(candidate, session?.id, session));
        }
        const message = registrationLimited
          ? "Some candidate files changed or could not be registered; locations are shown without stable references."
          : result.fuzzy.message;
        const fuzzy = {
          status: result.fuzzy.status,
          ...(message === undefined ? {} : { message }),
          candidates: groups,
        };
        const rows = [...result.notices, "No matches found."];
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
            ...(session?.target === undefined ? {} : { target: session.target, matchTargets: [] }),
            fuzzyPresentation: createFuzzyPresentation(result.fuzzy.candidates, context.cwd),
            fuzzy,
          } satisfies SearchToolDetails,
        };
      }

      const detailBudget = result.request.limit ?? 50;
      if (result.matches.length === 0) {
        return {
          content: [{ type: "text", text: [...result.notices, "No matches found."].join("\n") }],
          details: {
            ...createSearchToolDetails(result.request.query, [], result.complete, context.cwd),
            ...(session?.target === undefined ? {} : { target: session.target, matchTargets: [] }),
          },
        };
      }
      const display = session ?? {
        query: result.request.query,
        matches: result.matches,
        complete: result.complete,
      };
      return {
        content: [
          {
            type: "text",
            text: [
              ...result.notices,
              formatSearchSession(display, context.cwd, detailBudget, session !== undefined),
            ].join("\n"),
          },
        ],
        details: {
          ...createSearchToolDetails(
            display.query,
            display.matches,
            display.complete,
            context.cwd,
            session?.id,
            detailBudget,
          ),
          ...(session?.target === undefined
            ? {}
            : { target: session.target, matchTargets: session.matchTargets }),
        },
      };
    },
    renderResult: renderSearchResult as SearchResolver["renderResult"],
  };
}

function formatSearchSession(
  session: Omit<TextSearchSession, "id"> & { readonly id?: string },
  cwd: string,
  detailBudget: number,
  anchorsRegistered = true,
): string {
  const fileCount = new Set(session.matches.map((match) => match.source)).size;
  const count = session.matches.length;
  const summary = `${String(count)}${session.complete ? "" : "+"} ${plural(count, "match", "matches")} in ${String(fileCount)} ${plural(fileCount, "file", "files")}`;
  const heading = anchorsRegistered
    ? session.complete
      ? `SEARCH#${session.id}:all:line / SEARCH#${session.id}:all:match — ${summary}`
      : `${summary} (limit reached; no all anchors were registered)`
    : `${summary} (files changed during search; results shown without anchors)`;
  const lines = anchorsRegistered ? [SEARCH_ANCHOR_LEGEND, heading] : [heading];
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
        lines.push(`  ×${String(group.matchCount)} ${previewLine(group.text)}`);
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
      const location = `${source}:${String(match.lineNumber)}:${String(match.startColumn + 1)}-${String(match.endColumn + 1)}`;
      lines.push(
        anchorsRegistered
          ? `${location} SEARCH#${session.id}:${String(index)}:line SEARCH#${session.id}:${String(index)}:match`
          : location,
        `  ${previewMatch(match)}`,
      );
    }
  }

  return lines.join("\n");
}

function previewMatch(match: TextSearchMatch): string {
  const context = 64;
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
function displaySource(source: string, cwd: string): string {
  const relative = path.relative(cwd, source);
  // oxlint-disable-next-line repo/no-parent-paths -- defensive check against traversal, not a traversal
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : source;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}
