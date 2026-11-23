/**
 * LSP document symbol queries — textDocument/documentSymbol.
 *
 * Language-agnostic — works with any LSP server that supports
 * documentSymbolProvider.
 */
import type { LspClient } from "./client.ts";
import type { LspManager } from "./manager.ts";
import type { LspRange } from "./types.ts";
import { sourceChanged } from "./source-changes.ts";
import { hasTypeScriptProjectQueries, requestTsserver } from "./project.ts";

// ── Types ────────────────────────────────────────────────────────────

/**
Raw LSP DocumentSymbol, as returned by the server.
*/
export interface LspDocumentSymbol {
  name: string;
  kind: number;
  /** Extra information, such as clangd's signature `int (int, int) const`. */
  detail?: string;
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
  signal?: AbortSignal,
): Promise<LspDocumentSymbol[]> {
  const version = client.documentVersion(uri);
  const result = await client.sendRequest<LspDocumentSymbol[] | null>(
    "textDocument/documentSymbol",
    { textDocument: { uri } },
    signal,
  );
  if (client.documentVersion(uri) !== version)
    throw sourceChanged("The document changed while the server listed its symbols.");
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

interface TsNavigateToItem {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly start: { readonly line: number; readonly offset: number };
  readonly end: { readonly line: number; readonly offset: number };
}

// Match typescript-language-server's SymbolKind conversion when no outline entry is available.
const TS_SYMBOL_KIND = new Map([
  ["file", 1],
  ["module", 2],
  ["class", 5],
  ["local class", 5],
  ["method", 6],
  ["getter", 6],
  ["setter", 6],
  ["property", 7],
  ["JSX attribute", 7],
  ["field", 8],
  ["constructor", 9],
  ["enum", 10],
  ["interface", 11],
  ["function", 12],
  ["local function", 12],
  ["const", 14],
  ["enum member", 14],
]);

async function requestTypeScriptSymbols(
  client: LspClient,
  query: string,
  signal?: AbortSignal,
): Promise<LspWorkspaceSymbol[]> {
  // TLS passes its first open file to navto, which can select an unrelated project or a
  // document retained by another session. Omitting file searches all of its loaded projects.
  const items = await requestTsserver<TsNavigateToItem[]>(
    client,
    ["navto", { searchValue: query }],
    signal,
  );
  const position = ({ line, offset }: TsNavigateToItem["start"]) => ({
    line: line - 1,
    character: offset - 1,
  });
  // LSP erases tsserver's distinction between import aliases and real declarations.
  return (items ?? [])
    .filter(({ kind }) => kind !== "alias")
    .map((item) => ({
      name: item.name,
      kind: TS_SYMBOL_KIND.get(item.kind) ?? 13,
      location: {
        uri: client.serverPathToDocumentUri(item.file),
        range: { start: position(item.start), end: position(item.end) },
      },
    }));
}

/**
Request workspace symbols from one native LSP server.
*/
export async function requestWorkspaceSymbols(
  client: LspClient,
  query: string,
  limit = 100,
  signal?: AbortSignal,
): Promise<LspWorkspaceSymbol[]> {
  if (hasTypeScriptProjectQueries(client))
    return (await requestTypeScriptSymbols(client, query, signal)).slice(0, limit);
  const result = await client.sendRequest<LspWorkspaceSymbol[] | null>(
    "workspace/symbol",
    {
      query,
    },
    signal,
  );
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
    const symbols = await requestWorkspaceSymbols(client, query, 100);
    const symbol = symbols.find((item) => item.name === query) ?? symbols[0];

    if (symbol) {
      return { client, symbol };
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
