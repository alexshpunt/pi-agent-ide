import { searchSymbols } from "./lsp/symbol-search.js";
import path from "node:path";
import { selectionData, renderSearchMatches } from "pi-agent-search/api/search";
import type { LspManager } from "./lsp/manager.js";
import type { SymbolHit } from "./lsp/symbol-search.js";
import type { SearchPluginApi, SearchResolver } from "pi-agent-search/api/search";

/** Expose strict LSP discovery and explicit reference navigation as shared source targets. */
export function createLspSearchResolver(
  managerFor: (cwd: string) => Promise<LspManager>,
  registerSelection: SearchPluginApi["registerSelection"],
): SearchResolver {
  return {
    id: "symbols",
    supportsResultScope: true,
    // Workspace symbol backends may read beyond the requested path.
    readResources: (request) => (request.query.startsWith("symbols:") ? undefined : []),
    toScriptData(payload) {
      return (payload as { readonly data: unknown }).data;
    },
    async tryResolve(request, context) {
      if (!request.query.startsWith("symbols:")) return { kind: "not-handled" };
      const query = request.query.slice("symbols:".length).trim();
      if (query.length === 0)
        return { kind: "failed", error: new Error("symbols: query must not be empty") };
      const manager = await managerFor(context.cwd);
      const collect = (signal?: AbortSignal) =>
        searchSymbols(
          query,
          context.cwd,
          request.limit ?? 100,
          signal,
          { ...request, ...(context.scope === undefined ? {} : { resultScope: context.scope }) },
          manager,
        );
      const found = await collect(context.signal);
      const session = await registerSelection(
        {
          request,
          matches: found.hits,
          complete: found.complete,
          refresh: async (signal) => {
            const refreshed = await collect(signal);
            return { matches: refreshed.hits, complete: refreshed.complete };
          },
        },
        context,
      );
      const data = selectionData(found.hits, found.complete, session.id, session);
      return {
        kind: "resolved",
        payload: {
          query,
          hits: found.hits,
          complete: found.complete,
          navigation: request.navigation,
          data: {
            ...data,
            matches: data.matches.map((match, index) => ({
              ...match,
              role: found.hits[index]?.role,
              symbol: found.hits[index]?.symbol,
            })),
          },
        },
      };
    },
    renderResult(result, options, theme) {
      const data = result.details as {
        hits: readonly SymbolHit[];
        complete: boolean;
        navigation?: "references";
        cwd: string;
      };
      return renderSearchMatches(
        data.hits,
        data.complete,
        theme,
        options.expanded,
        data.cwd,
        data.navigation === "references"
          ? ["LSP reference navigation · may leave input scope"]
          : [],
        data.hits.map((hit) => `${hit.role} ${hit.symbol.name}`),
      );
    },
    format(payload, context) {
      const result = payload as {
        readonly query: string;
        readonly hits: readonly SymbolHit[];
        readonly complete: boolean;
        readonly navigation?: "references";
      };
      const heading =
        result.navigation === "references"
          ? "LSP reference navigation (may leave input scope)"
          : "LSP symbols inside scope";
      const lines =
        result.hits.length === 0
          ? ["No symbols found."]
          : result.hits
              .slice(0, 100)
              .map(
                (hit, index) =>
                  `${String(index + 1)}. ${path.relative(context.cwd, hit.source)}:${String(hit.lineNumber)}:${String(hit.startColumn + 1)} ${hit.role} ${hit.symbol.name}`,
              );
      if (!result.complete) lines.push("Incomplete results; not a complete edit scope.");
      if (result.hits.length > 100) lines.push("Preview shortened; full source targets retained.");
      return {
        content: [{ type: "text", text: [heading, ...lines].join("\n") }],
        details: { ...result, cwd: context.cwd },
      };
    },
  };
}
