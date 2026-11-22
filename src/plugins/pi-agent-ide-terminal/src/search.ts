import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import {
  SEARCH_API_VERSION,
  SEARCH_PROTOCOL,
  type SearchPlugin,
} from "pi-agent-search/api/plugin-protocol";
import type { SearchRequest, SearchSelectionMatch } from "pi-agent-search/api/search";
import { selectionData, renderSearchMatches } from "pi-agent-search/api/search";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.ts";
import type { TerminalSessionSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/types.ts";

interface TerminalSearchPayload {
  /** Requested scope: one session or `shell:` for every listed session. */
  readonly source: string;
  /** Searched sessions with the status each had at search time. */
  readonly sessions: readonly { readonly source: string; readonly status: string }[];
  readonly query: string;
  readonly matches: readonly SearchSelectionMatch[];
  readonly complete: boolean;
}

/** Register retained terminal output as a searchable resource. */
export async function registerTerminalSearch(
  pi: ExtensionAPI,
  manager: TerminalSessionManager,
  ownerSessionId: () => string | undefined = () => undefined,
): Promise<void> {
  const plugin = {
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "terminal",
    setup(api) {
      api.addResolver({
        resolver: terminalSearchResolver(manager, ownerSessionId),
        // Before the filesystem regex resolver (-10), which reads `shell:` as a file path.
        priority: -20,
      });
    },
  } satisfies SearchPlugin;
  await connectSearchPlugin(pi, plugin);
}

function terminalSearchResolver(
  manager: TerminalSessionManager,
  ownerSessionId: () => string | undefined,
) {
  return {
    readResources: (request: SearchRequest) =>
      request.path?.startsWith("shell:") ? [request.path] : [],
    id: "terminal",
    toScriptData(payload: unknown) {
      const result = parsePayload(payload);
      return selectionData(result.matches, result.complete);
    },
    async tryResolve(request: SearchRequest) {
      if (request.path === undefined || !request.path.startsWith("shell:")) {
        return { kind: "not-handled" as const };
      }
      try {
        terminalMatcher(request);
      } catch (error) {
        return { kind: "failed" as const, error };
      }
      let snapshots: readonly TerminalSessionSnapshot[];
      if (request.path === "shell:") {
        snapshots = manager.listOwnedBy(ownerSessionId());
      } else {
        const session = manager.get(request.path);
        if (session === undefined) {
          return {
            kind: "failed" as const,
            error: new Error(
              `Unknown terminal session ${request.path}. Read shell: to list your terminal sessions.`,
            ),
          };
        }
        snapshots = [manager.snapshot(session)];
      }
      const maximum = request.limit ?? 100;
      const matches: SearchSelectionMatch[] = [];
      for (const snapshot of snapshots) {
        if (matches.length >= maximum) break;
        matches.push(
          ...findTerminalMatches(snapshot, { ...request, limit: maximum - matches.length }),
        );
      }
      return {
        kind: "resolved" as const,
        payload: {
          source: request.path,
          sessions: snapshots.map(({ source, status }) => ({ source, status })),
          query: request.query,
          matches,
          // Output keeps growing and older output may be dropped, so a match set is never final.
          complete: false,
        } satisfies TerminalSearchPayload,
      };
    },
    format(payload: unknown) {
      const result = parsePayload(payload);
      const lines = result.matches.map(
        (match) => `${match.source}:${match.lineNumber}: ${match.lineText}`,
      );
      const scope =
        result.source === "shell:"
          ? `${result.sessions.length} terminal session${result.sessions.length === 1 ? "" : "s"}`
          : result.source;
      const text =
        result.source === "shell:" && result.sessions.length === 0
          ? "No terminal sessions in this Pi session to search."
          : lines.length === 0
            ? `No matches in ${scope}`
            : `${lines.join("\n")}\n\n${lines.length} match${lines.length === 1 ? "" : "es"} in ${scope}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { source: result.source, payload: result },
      };
    },
    renderResult(
      result: { details: unknown },
      options: { readonly expanded?: boolean },
      theme: Theme,
    ) {
      const details = result.details;
      const payload = isRecord(details) ? parsePayload(details.payload) : parsePayload(undefined);
      return renderSearchMatches(
        payload.matches,
        false,
        theme,
        options.expanded === true,
        undefined,
        [
          payload.source === "shell:"
            ? `Retained terminal output · ${payload.sessions.length} sessions · read-only`
            : `Retained terminal output · ${payload.sessions[0]?.status ?? "unknown"} · read-only`,
        ],
      );
    },
  };
}

const REGEX_PREFIX = "regex:";

/** Find line matches of a literal query, or of a `regex:` query, in a line of retained output. */
function terminalMatcher(request: SearchRequest): (lineText: string) => Iterable<[number, number]> {
  if (request.query.startsWith(REGEX_PREFIX)) {
    const pattern = request.query.slice(REGEX_PREFIX.length);
    if (pattern.length === 0) return () => [];
    const expression = new RegExp(pattern, request.caseSensitive === true ? "gu" : "giu");
    return function* (lineText) {
      for (const found of lineText.matchAll(expression)) {
        const end = found.index + found[0].length;
        if (
          found[0].length > 0 &&
          (request.wholeWord !== true || isWordBoundary(lineText, found.index, end))
        )
          yield [found.index, end];
      }
    };
  }
  const query = request.caseSensitive === true ? request.query : request.query.toLocaleLowerCase();
  if (query.length === 0) return () => [];
  return function* (lineText) {
    const haystack = request.caseSensitive === true ? lineText : lineText.toLocaleLowerCase();
    let column = 0;
    for (;;) {
      const start = haystack.indexOf(query, column);
      if (start < 0) return;
      const end = start + query.length;
      if (request.wholeWord !== true || isWordBoundary(haystack, start, end)) yield [start, end];
      column = Math.max(end, start + 1);
    }
  };
}

/**
 * Find matches in retained output without claiming a complete source scope. A query is literal
 * unless it starts with `regex:`; an invalid regular expression throws.
 */
export function findTerminalMatches(
  snapshot: TerminalSessionSnapshot,
  request: SearchRequest,
): SearchSelectionMatch[] {
  const find = terminalMatcher(request);
  const matches: SearchSelectionMatch[] = [];
  const maximum = request.limit ?? 100;
  for (const [index, lineText] of snapshot.output.replaceAll("\r", "").split("\n").entries()) {
    for (const [startColumn, endColumn] of find(lineText)) {
      if (matches.length >= maximum) return matches;
      matches.push({
        source: snapshot.source,
        lineNumber: index + 1,
        startColumn,
        endColumn,
        matchedText: lineText.slice(startColumn, endColumn),
        lineText,
      });
    }
    if (matches.length >= maximum) break;
  }
  return matches;
}

function isWordBoundary(text: string, start: number, end: number): boolean {
  return !/[\p{L}\p{N}_]/u.test(text[start - 1] ?? "") && !/[\p{L}\p{N}_]/u.test(text[end] ?? "");
}

function parsePayload(value: unknown): TerminalSearchPayload {
  if (!isTerminalSearchPayload(value)) throw new TypeError("Invalid terminal search result");
  return value;
}

function isTerminalSearchPayload(value: unknown): value is TerminalSearchPayload {
  return (
    isRecord(value) &&
    typeof value.source === "string" &&
    typeof value.query === "string" &&
    Array.isArray(value.matches) &&
    Array.isArray(value.sessions)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
