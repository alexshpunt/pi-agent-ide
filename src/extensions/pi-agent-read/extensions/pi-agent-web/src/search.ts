import type { ResourceResolver } from "pi-agent-resource";
import {
  selectionData,
  renderSearchMatches,
  FuzzyVocabulary,
  fuzzyLimits,
  isFuzzyQuery,
  rankFuzzyIdentifiers,
  fuzzyCandidateData,
  formatFuzzyCandidate,
  type FuzzyResult,
  type SearchRequest,
  type SearchResolver,
  type SearchSelectionMatch,
} from "pi-agent-search/api/search";

interface WebSearchResult {
  readonly source: string;
  readonly matches: readonly SearchSelectionMatch[];
  readonly complete: boolean;
  readonly fuzzy?: FuzzyResult;
}

/** Search the same converted HTTP(S) content as Read, without treating URLs as files. */
export function createWebSearchResolver(web: ResourceResolver): SearchResolver {
  return {
    id: "web",
    readResources: (request) =>
      request.path !== undefined && /^https?:/iu.test(request.path) ? [request.path] : [],
    async tryResolve(request, context) {
      const source = request.path;
      if (source === undefined || !/^https?:/iu.test(source)) return { kind: "not-handled" };
      if (request.include !== undefined || request.exclude !== undefined) {
        return {
          kind: "failed",
          error: new Error("File include/exclude globs do not apply to a web page."),
        };
      }
      const pattern = searchPattern(request);
      const resolved = await web.tryResolve(source, context);
      if (resolved.kind !== "resolved") return resolved;
      if (resolved.resource.read === undefined)
        return { kind: "failed", error: new Error(`Cannot read ${source}`) };
      const content = await resolved.resource.read({ signal: context.signal });
      if (content.some((block) => block.type !== "text")) {
        return { kind: "failed", error: new Error(`Web search requires text content: ${source}`) };
      }
      const text = content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      const matches: SearchSelectionMatch[] = [];
      const maximum = request.limit ?? 50;
      for (const [index, lineText] of text.split(/\r\n|\n|\r/u).entries()) {
        context.signal?.throwIfAborted();
        for (const match of lineText.matchAll(pattern)) {
          if (match[0].length === 0) continue;
          const startColumn = match.index;
          const endColumn = startColumn + match[0].length;
          if (
            request.wholeWord === true &&
            (/\p{L}|\p{N}|_/u.test(lineText[startColumn - 1] ?? "") ||
              /\p{L}|\p{N}|_/u.test(lineText[endColumn] ?? ""))
          )
            continue;
          if (matches.length === maximum)
            return {
              kind: "resolved",
              payload: { source, matches, complete: false } satisfies WebSearchResult,
            };
          matches.push({
            source,
            lineNumber: index + 1,
            startColumn,
            endColumn,
            matchedText: match[0],
            lineText,
          });
        }
      }
      const fuzzy =
        matches.length === 0 && isFuzzyQuery(request.query)
          ? searchFuzzyText(text, source, request.query, context.signal)
          : undefined;
      return {
        kind: "resolved",
        payload: {
          source,
          matches,
          complete: true,
          ...(fuzzy === undefined ? {} : { fuzzy }),
        } satisfies WebSearchResult,
      };
    },
    toScriptData(payload) {
      const result = payload as WebSearchResult;
      return {
        ...selectionData(result.matches, result.complete),
        ...(result.fuzzy === undefined
          ? {}
          : {
              fuzzy: {
                ...result.fuzzy,
                candidates: result.fuzzy.candidates.map((candidate) =>
                  fuzzyCandidateData(candidate),
                ),
              },
            }),
      };
    },
    renderResult(result, options, theme) {
      const data = result.details as WebSearchResult;
      return renderSearchMatches(data.matches, data.complete, theme, options.expanded, undefined, [
        "Web page · read-only",
        ...(!data.complete ? ["Limit reached · incomplete results"] : []),
      ]);
    },
    format(payload) {
      const result = payload as WebSearchResult;
      const heading =
        result.matches.length === 0
          ? `No matches in ${result.source}`
          : `${result.matches.length}${result.complete ? "" : "+"} matches in ${result.source}${result.complete ? "" : " (limit reached)"}`;
      const rows = [heading];
      if (result.fuzzy?.status === "skipped")
        rows.push(`Possible-name fallback skipped: ${result.fuzzy.message}`);
      if (result.fuzzy?.candidates.length)
        rows.push(
          "Possible names — spelling suggestions, not equivalent behavior.",
          ...result.fuzzy.candidates.map((candidate) =>
            formatFuzzyCandidate(fuzzyCandidateData(candidate)),
          ),
        );
      let bytes = Buffer.byteLength(heading);
      for (const match of result.matches) {
        const row = `${result.source}:${match.lineNumber}:${match.startColumn + 1} ${previewMatch(match)}`;
        bytes += Buffer.byteLength(row) + 1;
        if (bytes > 48 * 1024) {
          rows.push("Output shortened. Narrow the query or lower the limit.");
          break;
        }
        rows.push(row);
      }
      return { content: [{ type: "text", text: rows.join("\n") }], details: result };
    },
  };
}

function searchFuzzyText(
  text: string,
  source: string,
  query: string,
  signal?: AbortSignal,
): FuzzyResult | undefined {
  signal?.throwIfAborted();
  const start = performance.now();
  const vocabulary = new FuzzyVocabulary();
  vocabulary.addText(text);
  if (vocabulary.limited)
    return {
      status: "skipped",
      message: "name collection reached its byte or unique-name budget",
      candidates: [],
    };
  const candidates = [];
  for (const name of rankFuzzyIdentifiers(query, vocabulary.names)) {
    signal?.throwIfAborted();
    if (performance.now() - start > fuzzyLimits.timeoutMs)
      return { status: "skipped", message: "extra search reached its time budget", candidates: [] };
    const pattern = new RegExp(name.identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu");
    const matches: SearchSelectionMatch[] = [];
    let complete = true;
    let bytes = 0;
    scan: for (const [index, lineText] of text.split(/\r\n|\n|\r/u).entries()) {
      if (performance.now() - start > fuzzyLimits.timeoutMs)
        return {
          status: "skipped",
          message: "extra search reached its time budget",
          candidates: [],
        };
      signal?.throwIfAborted();
      for (const match of lineText.matchAll(pattern)) {
        const startColumn = match.index;
        const endColumn = startColumn + match[0].length;
        if (
          /[\p{L}\p{N}_$]/u.test(lineText[startColumn - 1] ?? "") ||
          /[\p{L}\p{N}_$]/u.test(lineText[endColumn] ?? "")
        )
          continue;
        bytes += Buffer.byteLength(lineText);
        if (
          matches.length === fuzzyLimits.matchesPerCandidate ||
          bytes > fuzzyLimits.verificationBytes
        ) {
          complete = false;
          break scan;
        }
        matches.push({
          source,
          lineNumber: index + 1,
          startColumn,
          endColumn,
          matchedText: match[0],
          lineText,
        });
      }
    }
    if (matches.length > 0) candidates.push({ ...name, matches, complete });
  }
  return candidates.length === 0 ? undefined : { status: "ready", candidates };
}
function previewMatch(match: SearchSelectionMatch): string {
  const from = Math.max(0, match.startColumn - 64);
  const to = Math.min(match.lineText.length, match.startColumn + 192);
  return `${from > 0 ? "…" : ""}${match.lineText.slice(from, to)}${to < match.lineText.length ? "…" : ""}`;
}
function searchPattern(request: SearchRequest): RegExp {
  const query = request.query;
  const literal = query.startsWith('"') && query.endsWith('"') ? query.slice(1, -1) : query;
  const pattern = query.startsWith("regex:")
    ? query.slice(6)
    : literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(pattern, request.caseSensitive === true ? "gu" : "giu");
}
