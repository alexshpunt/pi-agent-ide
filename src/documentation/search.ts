import {
  renderSearchMatches,
  selectionData,
  type SearchRequest,
  type SearchResolver,
  type SearchSelectionMatch,
} from "pi-agent-search/api/search";
import type { AgentDocumentationRegistry } from "#src/documentation/registry.js";

interface DocumentationSearchResult {
  readonly source: string;
  readonly matches: readonly SearchSelectionMatch[];
  readonly complete: boolean;
  readonly reason?: "limit" | "output";
}

/** Search current packaged guide bodies without granting edit targets or marking guides read. */
export function createDocumentationSearchResolver(
  registry: AgentDocumentationRegistry,
): SearchResolver {
  return {
    id: "agent-documentation",
    readResources: (request) => (request.path?.startsWith("docs:") === true ? [request.path] : []),
    async tryResolve(request, context) {
      const source = request.path;
      if (source === undefined || !source.startsWith("docs:")) return { kind: "not-handled" };
      if (request.include !== undefined || request.exclude !== undefined)
        return {
          kind: "failed",
          error: new Error("File include/exclude globs do not apply to docs: resources."),
        };
      if (/^(?:files|ast|symbols|process):/u.test(request.query))
        return {
          kind: "failed",
          error: new Error("Use a text or regex: query for docs: resources."),
        };
      const id = source.slice("docs:".length);
      const guide = id.length === 0 ? undefined : registry.get(id);
      if (id.length > 0 && guide === undefined)
        return { kind: "failed", error: new Error(`Unknown documentation ID: ${id}`) };
      const pattern = searchPattern(request);
      const matches: SearchSelectionMatch[] = [];
      const maximum = request.limit ?? 50;
      let bytes = 0;
      for (const document of guide === undefined ? registry.list() : [guide]) {
        context.signal?.throwIfAborted();
        for (const [index, lineText] of document.markdown.split(/\r\n|\n|\r/u).entries()) {
          context.signal?.throwIfAborted();
          for (const found of lineText.matchAll(pattern)) {
            if (found[0].length === 0) continue;
            const startColumn = found.index;
            const endColumn = startColumn + found[0].length;
            if (
              request.wholeWord === true &&
              (/[\p{L}\p{N}_]/u.test(lineText[startColumn - 1] ?? "") ||
                /[\p{L}\p{N}_]/u.test(lineText[endColumn] ?? ""))
            )
              continue;
            if (matches.length === maximum)
              return {
                kind: "resolved",
                payload: {
                  source,
                  matches,
                  complete: false,
                  reason: "limit",
                } satisfies DocumentationSearchResult,
              };
            const match: SearchSelectionMatch = {
              source: `docs:${document.id}`,
              lineNumber: index + 1,
              startColumn,
              endColumn,
              matchedText: found[0],
              lineText,
            };
            bytes += Buffer.byteLength(matchRow(match)) + 1;
            if (bytes > 48 * 1024)
              return {
                kind: "resolved",
                payload: {
                  source,
                  matches,
                  complete: false,
                  reason: "output",
                } satisfies DocumentationSearchResult,
              };
            matches.push(match);
          }
        }
      }
      return {
        kind: "resolved",
        payload: { source, matches, complete: true } satisfies DocumentationSearchResult,
      };
    },
    toScriptData(payload) {
      const result = payload as DocumentationSearchResult;
      return selectionData(result.matches, result.complete);
    },
    format(payload) {
      const result = payload as DocumentationSearchResult;
      const count = `${result.matches.length}${result.complete ? "" : "+"}`;
      const heading =
        result.matches.length === 0 && result.complete
          ? `No matches in ${result.source}`
          : `${count} matches in ${result.source}`;
      return {
        content: [
          {
            type: "text",
            text: [heading, ...notices(result), ...result.matches.map(matchRow)].join("\n"),
          },
        ],
        details: result,
      };
    },
    renderResult(result, options, theme) {
      const data = result.details as DocumentationSearchResult;
      return renderSearchMatches(
        data.matches,
        data.complete,
        theme,
        options.expanded,
        undefined,
        notices(data),
      );
    },
  };
}

function notices(result: DocumentationSearchResult): string[] {
  return [
    "Packaged guides · read-only. Read docs:<id> for the full guide; search excerpts do not mark it read.",
    ...(result.reason === "limit"
      ? ["Limit reached · incomplete results. Narrow the query or raise limit."]
      : []),
    ...(result.reason === "output"
      ? ["Output shortened · incomplete results. Narrow the query."]
      : []),
  ];
}

function matchRow(match: SearchSelectionMatch): string {
  const from = Math.max(0, match.startColumn - 64);
  const to = Math.min(match.lineText.length, match.startColumn + 192);
  const preview = `${from > 0 ? "…" : ""}${match.lineText.slice(from, to)}${to < match.lineText.length ? "…" : ""}`;
  return `${match.source}:${match.lineNumber}:${match.startColumn + 1} ${preview}`;
}

function searchPattern(request: SearchRequest): RegExp {
  if (/\r|\n/u.test(request.query)) throw new Error("Search supports one-line patterns only.");
  const query = request.query;
  const literal = query.startsWith('"') && query.endsWith('"') ? query.slice(1, -1) : query;
  const pattern = query.startsWith("regex:")
    ? query.slice(6)
    : literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(pattern, request.caseSensitive === true ? "gu" : "giu");
}
