import path from "node:path";

import { URI } from "vscode-uri";

import { LspManager } from "./manager.js";
import { requestReferences } from "./navigation.js";
import { type LspWorkspaceSymbol, requestWorkspaceSymbols } from "./symbols.js";

export interface SymbolHit {
  filePath: string;
  lineNumber: number;
  column: number;
  kind: string;
  name: string;
}

function uriToFilePath(uri: string): string {
  try {
    return URI.parse(uri).fsPath;
  } catch {
    return uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
  }
}

function toHit(
  cwd: string,
  symbol: LspWorkspaceSymbol,
  uri: string,
  line: number,
  character: number,
): SymbolHit {
  const filePath = uriToFilePath(uri);
  const relativePath = path.relative(cwd, filePath);

  return {
    filePath: relativePath.startsWith("..") ? filePath : relativePath,
    lineNumber: line + 1,
    column: character + 1,
    kind: String(symbol.kind),
    name: symbol.name,
  };
}

/**
Search workspace symbols and their references through native LSP servers.
*/
export async function searchSymbols(
  query: string,
  cwd: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SymbolHit[]> {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  const manager = LspManager.getInstance();
  const clients = await manager.prepareWorkspaceSymbols(cwd);
  const definitions: LspWorkspaceSymbol[] = [];

  for (const client of clients) {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }

    try {
      definitions.push(...(await requestWorkspaceSymbols(client, query, limit)));
    } catch {
      // A server without workspace/symbol support cannot contribute results.
    }
  }

  const seen = new Set<string>();
  const hits: SymbolHit[] = [];

  for (const symbol of definitions) {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }

    if (hits.length >= limit) {
      break;
    }

    const definition = symbol.location;
    const definitionHit = toHit(
      cwd,
      symbol,
      definition.uri,
      definition.range.start.line,
      definition.range.start.character,
    );
    const definitionKey = `${definitionHit.filePath}:${definitionHit.lineNumber}:${definitionHit.column}`;

    if (!seen.has(definitionKey)) {
      seen.add(definitionKey);
      hits.push(definitionHit);
    }

    if (hits.length >= limit) {
      break;
    }

    const sourcePath = uriToFilePath(definition.uri);
    const opened = await manager.openFile(sourcePath, cwd, "symbols").catch(() => null);

    if (!opened) {
      continue;
    }

    const references = await requestReferences(
      opened.client,
      opened.uri,
      definition.range.start,
    ).catch(() => []);

    for (const reference of references) {
      const hit = toHit(
        cwd,
        symbol,
        reference.uri,
        reference.range.start.line,
        reference.range.start.character,
      );
      const key = `${hit.filePath}:${hit.lineNumber}:${hit.column}`;

      if (!seen.has(key)) {
        seen.add(key);
        hits.push(hit);
      }

      if (hits.length >= limit) {
        break;
      }
    }
  }

  return hits;
}
