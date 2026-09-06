import path from "node:path";

import { searchFiles } from "#src/file-search.js";
import { createSearchRecipe, runSearchRecipe, type SearchRecipe } from "#src/search-recipe.js";
import { renderSearchResult } from "#src/search-renderer.js";
import { createSearchToolDetails } from "#src/search-result.js";

import type {
  SearchSessionStore,
  TextSearchMatch,
  TextSearchSession,
} from "#src/search-session.js";
import type { SearchRequest, SearchResolver } from "pi-agent-search/api/search";

interface TextPayload {
  readonly request: SearchRequest;
  readonly matches: readonly TextSearchMatch[];
  readonly complete: boolean;
  readonly recipe: SearchRecipe;
  readonly notices: readonly string[];
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
    async tryResolve(request, context) {
      if (!request.query.startsWith("files:")) {
        return { kind: "not-handled" };
      }

      const query = request.query.slice("files:".length).trim();
      const result = await searchFiles(query, request, context.cwd, context.signal);
      return { kind: "resolved", payload: { query, ...result } satisfies FilePayload };
    },
    format(payload) {
      const result = payload as FilePayload;
      const heading = result.complete
        ? `${String(result.files.length)} files`
        : `${String(result.files.length)}+ files (limit reached)`;
      return {
        content: [{ type: "text", text: [heading, ...result.files].join("\n") }],
        details: { query: result.query, files: result.files, complete: result.complete },
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
    id,
    async tryResolve(request, context) {
      const recipe = queryBody(request);
      if (recipe === undefined) return { kind: "not-handled" };
      const result = await runSearchRecipe(recipe, context.cwd, context.signal);
      return {
        kind: "resolved",
        payload: {
          request: { ...request, query: result.query },
          ...result,
          recipe,
        } satisfies TextPayload,
      };
    },
    async format(payload, context) {
      const result = payload as TextPayload;

      if (result.matches.length === 0) {
        return {
          content: [{ type: "text", text: [...result.notices, "No matches found."].join("\n") }],
          details: createSearchToolDetails(result.request.query, [], result.complete, context.cwd),
        };
      }

      const session = await sessions.register(
        result.request.query,
        result.matches,
        result.complete,
        context.cwd,
        context.signal,
        result.recipe,
      );
      return {
        content: [
          {
            type: "text",
            text: [...result.notices, formatSearchSession(session, context.cwd)].join("\n"),
          },
        ],
        details: createSearchToolDetails(
          session.query,
          session.matches,
          session.complete,
          context.cwd,
          session.id,
        ),
      };
    },
    renderResult: renderSearchResult as SearchResolver["renderResult"],
  };
}

function formatSearchSession(session: TextSearchSession, cwd: string): string {
  const fileCount = new Set(session.matches.map((match) => match.source)).size;
  const count = session.matches.length;
  const heading = session.complete
    ? `SEARCH#${session.id}:all:line / SEARCH#${session.id}:all:match — ${String(count)} ${plural(count, "match", "matches")} in ${String(fileCount)} ${plural(
        fileCount,
        "file",
        "files",
      )}`
    : `${String(count)}+ matches in ${String(fileCount)} ${plural(
        fileCount,
        "file",
        "files",
      )} (limit reached; no all anchors were registered)`;
  let previousSource: string | undefined;
  const lines = [
    "Anchors: SEARCH#HASH:N:line (line), SEARCH#HASH:N:match (exact match), SEARCH#HASH:all:line (each unique containing line), SEARCH#HASH:all:match (every exact match)",
    heading,
  ];

  for (const [index, match] of session.matches.entries()) {
    if (previousSource !== undefined && previousSource !== match.source) {
      lines.push("");
    }

    const source = displaySource(match.source, cwd);
    lines.push(
      `${source}:${String(match.lineNumber)}:${String(match.startColumn + 1)}-${String(
        match.endColumn + 1,
      )} SEARCH#${session.id}:${String(index + 1)}:line SEARCH#${session.id}:${String(index + 1)}:match`,
      `  ${previewMatch(match)}`,
    );
    previousSource = match.source;
  }

  if (!session.complete) {
    lines.push("", "Increase limit and search again before applying a complete replacement.");
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
