import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import {
  SEARCH_API_VERSION,
  SEARCH_PROTOCOL,
  type SearchPlugin,
} from "pi-agent-search/api/plugin-protocol";
import type { SearchRequest, SearchSelectionMatch } from "pi-agent-search/api/search";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { renderTerminalAction } from "#src/plugins/pi-agent-ide-terminal/src/renderer.js";
import type { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import type { TerminalSessionSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/types.js";

interface TerminalSearchPayload {
  readonly snapshot: TerminalSessionSnapshot;
  readonly query: string;
  readonly matches: readonly SearchSelectionMatch[];
}

/** Register retained terminal output as a searchable resource. */
export async function registerTerminalSearch(
  pi: ExtensionAPI,
  manager: TerminalSessionManager,
): Promise<void> {
  const plugin = {
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "terminal",
    setup(api) {
      api.addResolver({ resolver: terminalSearchResolver(manager), priority: 100 });
      api.describe(
        "path shell:<session> searches the retained text output of that terminal, including rows outside its current screen.",
      );
      api.addPromptGuideline(
        "Use search with path shell:<session> to find text in retained terminal output. Read the same shell source with the returned line number when more context is needed.",
      );
    },
  } satisfies SearchPlugin;
  await connectSearchPlugin(pi, plugin);
}

function terminalSearchResolver(manager: TerminalSessionManager) {
  return {
    id: "terminal",
    async tryResolve(request: SearchRequest) {
      if (request.path === undefined || !request.path.startsWith("shell:")) {
        return { kind: "not-handled" as const };
      }
      const session = manager.get(request.path);
      if (session === undefined) {
        return {
          kind: "failed" as const,
          error: new Error(`Unknown terminal session ${request.path}`),
        };
      }
      const snapshot = manager.snapshot(session);
      const matches = findTerminalMatches(snapshot, request);
      return {
        kind: "resolved" as const,
        payload: {
          snapshot,
          query: request.query,
          matches,
        },
      };
    },
    format(payload: unknown) {
      const result = parsePayload(payload);
      const lines = result.matches.map(
        (match) => `${result.snapshot.source}:${match.lineNumber}: ${match.lineText}`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              lines.length === 0
                ? `No matches in ${result.snapshot.source}`
                : `${lines.join("\n")}\n\n${lines.length} match${lines.length === 1 ? "" : "es"} in ${result.snapshot.source}`,
          },
        ],
        details: { source: result.snapshot.source, payload: result },
      };
    },
    renderResult(
      result: { details: unknown },
      _options: unknown,
      theme: Parameters<typeof renderTerminalAction>[4],
    ) {
      const details = result.details;
      const payload = isRecord(details) ? parsePayload(details.payload) : parsePayload(undefined);
      return renderTerminalAction(
        payload.snapshot,
        "search",
        JSON.stringify(payload.query),
        payload.matches.slice(-6).map((match) => `${match.lineNumber}: ${match.lineText}`),
        theme,
      );
    },
  };
}

export function findTerminalMatches(
  snapshot: TerminalSessionSnapshot,
  request: SearchRequest,
): SearchSelectionMatch[] {
  const query = request.caseSensitive === true ? request.query : request.query.toLocaleLowerCase();
  if (query.length === 0) return [];
  const matches: SearchSelectionMatch[] = [];
  const maximum = request.limit ?? 100;
  for (const [index, lineText] of snapshot.output.replaceAll("\r", "").split("\n").entries()) {
    const haystack = request.caseSensitive === true ? lineText : lineText.toLocaleLowerCase();
    let column = 0;
    while (matches.length < maximum) {
      const startColumn = haystack.indexOf(query, column);
      if (startColumn < 0) break;
      const endColumn = startColumn + query.length;
      const wholeWord =
        request.wholeWord !== true || isWordBoundary(haystack, startColumn, endColumn);
      if (wholeWord) {
        matches.push({
          source: snapshot.source,
          lineNumber: index + 1,
          startColumn,
          endColumn,
          matchedText: lineText.slice(startColumn, endColumn),
          lineText,
        });
      }
      column = Math.max(endColumn, startColumn + 1);
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
    typeof value.query === "string" &&
    Array.isArray(value.matches) &&
    isRecord(value.snapshot) &&
    typeof value.snapshot.source === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
