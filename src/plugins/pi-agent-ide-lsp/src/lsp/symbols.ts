/**
 * LSP document symbol queries — textDocument/documentSymbol.
 *
 * Language-agnostic — works with any LSP server that supports
 * documentSymbolProvider.
 */
import type { LspClient } from "./client.js";
import type { LspManager } from "./manager.js";
import type { LspRange } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

/**
Raw LSP DocumentSymbol, as returned by the server.
*/
export interface LspDocumentSymbol {
  name: string;
  kind: number;
  /**
    Range may be missing from some LSP servers (incomplete data).
    */
  range?: LspRange;
  selectionRange?: LspRange;
  children?: LspDocumentSymbol[];
}

// ── SymbolKind name mapping (LSP 3.17) ───────────────────────────────

const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

/**
Convert an LSP SymbolKind number to its human-readable name.
*/
export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? `SymbolKind(${kind})`;
}

// ── Request document symbols ─────────────────────────────────────────

/**
 * Request hierarchical document symbols from an LSP server.
 * Returns an empty array if the server returns null.
 */
export async function requestDocumentSymbols(
  client: LspClient,
  uri: string,
): Promise<LspDocumentSymbol[]> {
  const result = await client.sendRequest<LspDocumentSymbol[] | null>(
    "textDocument/documentSymbol",
    { textDocument: { uri } },
  );
  return result ?? [];
}

/**
Workspace symbol returned by the native LSP workspace/symbol request.
*/
export interface LspWorkspaceSymbol {
  name: string;
  kind: number;
  location: { uri: string; range: LspRange };
  containerName?: string;
}

/**
Request workspace symbols from one native LSP server.
*/
export async function requestWorkspaceSymbols(
  client: LspClient,
  query: string,
  limit = 100,
): Promise<LspWorkspaceSymbol[]> {
  const result = await client.sendRequest<LspWorkspaceSymbol[] | null>("workspace/symbol", {
    query,
  });
  return (result ?? []).slice(0, limit);
}

/**
Find the first workspace symbol across the native LSP clients for a workspace.
*/
export async function findWorkspaceSymbol(
  manager: LspManager,
  cwd: string,
  query: string,
): Promise<{ client: LspClient; symbol: LspWorkspaceSymbol } | undefined> {
  const clients = await manager.prepareWorkspaceSymbols(cwd);

  for (const client of clients) {
    try {
      const symbols = await requestWorkspaceSymbols(client, query, 100);
      const symbol = symbols.find((item) => item.name === query) ?? symbols[0];

      if (symbol) {
        return { client, symbol };
      }
    } catch {
      // Try the next configured language server.
    }
  }

  return undefined;
}

/**
Find a document symbol recursively by its exact name.
*/
export function findDocumentSymbol(
  symbols: LspDocumentSymbol[],
  name: string,
): LspDocumentSymbol | undefined {
  for (const symbol of symbols) {
    if (symbol.name === name) {
      return symbol;
    }

    const found = symbol.children ? findDocumentSymbol(symbol.children, name) : undefined;

    if (found) {
      return found;
    }
  }

  return undefined;
}
