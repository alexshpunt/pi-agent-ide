import { searchSymbols } from "./lsp/symbol-search.js";

import type { LspManager } from "./lsp/manager.js";
import type { SymbolHit } from "./lsp/symbol-search.js";
import type { SearchResolver } from "pi-agent-search/api/search";

export function createLspSearchResolver(managerFor: (cwd: string) => Promise<LspManager>): SearchResolver
{
    return {
        id: "lsp",
        async tryResolve(request, context)
        {
            if (!request.query.startsWith("lsp:"))
            {
                return { kind: "not-handled" };
            }

            const query = request.query.slice("lsp:".length).trim();

            if (query.length === 0)
            {
                return { kind: "failed", error: new Error("lsp: query must not be empty") };
            }

            await managerFor(context.cwd);
            const hits = await searchSymbols(query, context.cwd, request.limit ?? 100, context.signal);
            return { kind: "resolved", payload: { query, hits } };
        },
        format(payload)
        {
            const { query, hits } = payload as { readonly query: string; readonly hits: readonly SymbolHit[]; };
            const text = hits.length === 0
                ? "No LSP symbols found."
                : hits.map((hit, index) =>
                    `${String(index + 1)}. ${hit.filePath}:${String(hit.lineNumber)}:${
                        String(hit.column)
                    } ${hit.kind} ${hit.name}`
                ).join("\n");
            return { content: [{ type: "text", text }], details: { query, hits } };
        },
    };
}
