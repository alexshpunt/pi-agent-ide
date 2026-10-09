import { verifyResultTargets, type ResolvedResultTargets } from "pi-agent-resource";
import {
  selectionData,
  type SearchPluginApi,
  type SearchResolver,
} from "pi-agent-search/api/search";
import { searchSymbols, type SymbolHit } from "./lsp/symbol-search.js";
import path from "node:path";
import { renderSearchMatches } from "pi-agent-search/api/search";
import type { LspManager } from "./lsp/manager.js";

/** Expose strict LSP discovery and explicit reference navigation as shared source targets. */
export function createLspSearchResolver(
  managerFor: (cwd: string, source?: string, signal?: AbortSignal) => Promise<LspManager>,
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
      const scope = context.scope;
      const groups = new Map<LspManager, ResolvedResultTargets["targets"][number][]>();
      if (scope !== undefined) {
        await verifyResultTargets(scope, context.signal);
        for (const target of scope.targets) {
          const manager = await managerFor(context.cwd, target.source, context.signal);
          const group = groups.get(manager) ?? [];
          group.push(target);
          groups.set(manager, group);
        }
      } else {
        groups.set(await managerFor(context.cwd, request.path, context.signal), []);
      }
      const limit = request.limit ?? 100;
      const collect = async (signal?: AbortSignal) => {
        const hits: SymbolHit[] = [];
        let complete = scope?.complete ?? true;
        for (const [manager, targets] of groups) {
          const found = await searchSymbols(
            query,
            manager.workspaceRoot,
            limit,
            signal,
            {
              ...request,
              ...(scope === undefined
                ? {}
                : { resultScope: { targets, complete: scope.complete } }),
            },
            manager,
          );
          hits.push(...found.hits);
          complete = complete && found.complete;
        }
        if (scope !== undefined) await verifyResultTargets(scope, signal);
        return { hits: hits.slice(0, limit), complete: complete && hits.length <= limit };
      };
      const found = await collect(context.signal);
      const session = await registerSelection(
        {
          request,
          matches: found.hits,
          complete: found.complete,
          refresh: async (signal) => {
            const next = await collect(signal);
            return { matches: next.hits, complete: next.complete };
          },
        },
        context,
      );
      const data = selectionData(found.hits, found.complete, session.id, session);
      return {
        kind: "resolved",
        payload: {
          query,
          sessionId: session.id,
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
        readonly sessionId: string;
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
                  `SEARCH#${result.sessionId}:${index + 1}:match ${hit.source.startsWith("ssh://") ? hit.source : path.relative(context.cwd, hit.source)}:${hit.lineNumber}:${hit.startColumn + 1} ${hit.role} ${hit.symbol.name} · declared at ${hit.symbol.source.startsWith("ssh://") ? hit.symbol.source : path.relative(context.cwd, hit.symbol.source)}:${hit.symbol.range.startLine}:${hit.symbol.range.startColumn + 1}`,
              );
      if (result.complete && result.hits.length)
        lines.unshift(`SEARCH#${result.sessionId}:all:match selects all exact symbol matches.`);
      if (result.hits.length > 100) lines.push("Preview shortened; full source targets retained.");
      return {
        content: [{ type: "text", text: [heading, ...lines].join("\n") }],
        details: { ...result, cwd: context.cwd },
      };
    },
  };
}
