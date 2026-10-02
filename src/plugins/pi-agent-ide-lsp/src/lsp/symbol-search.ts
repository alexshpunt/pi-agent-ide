import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { requiredValue } from "pi-agent-invariant";
import { URI } from "vscode-uri";
import { createTextDocument } from "pi-agent-text";
import { verifyResultTargets, type ResolvedResultTargets } from "pi-agent-resource";
import { containsSearchMatch, type SearchSelectionMatch } from "pi-agent-search/api/search";

import { LspManager } from "./manager.js";
import { requestReferences, type LspLocation } from "./navigation.js";
import {
  requestWorkspaceSymbols,
  requestDocumentSymbols,
  type LspDocumentSymbol,
} from "./symbols.js";
import type { LspRange } from "./types.js";

/** Strict discovery scope, or an explicit seed scope for reference navigation. */
export interface SymbolSearchScope {
  readonly path?: string;
  readonly include?: string;
  readonly exclude?: string;
  readonly resultScope?: ResolvedResultTargets;
  readonly navigation?: "references";
}

/** Provider identity is the declaration's source/range, not its display name. */
export interface SearchSymbol {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly source: string;
  readonly range: {
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
  };
}

/** Exact source match with the declaration that produced this reference. */
export interface SymbolHit extends SearchSelectionMatch {
  readonly role: "definition" | "reference";
  readonly symbol: SearchSymbol;
}

function withinPath(file: string, cwd: string, scope: SymbolSearchScope): boolean {
  const relative = path.relative(path.resolve(cwd, scope.path ?? "."), file);
  // oxlint-disable-next-line repo/no-parent-paths -- reject results outside the requested scope.
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return false;
  const candidate = path.relative(cwd, file).split(path.sep).join("/");
  const matches = (patterns: string) =>
    patterns.split(",").some((value) => {
      const glob = value.trim();
      return (
        glob.length > 0 &&
        path.matchesGlob(glob.includes("/") ? candidate : path.basename(file), glob)
      );
    });
  return (
    (scope.include === undefined || matches(scope.include)) &&
    (scope.exclude === undefined || !matches(scope.exclude))
  );
}

function sourceOf(uri: string): string {
  const parsed = URI.parse(uri);
  if (parsed.scheme !== "file") throw new Error("LSP Search supports only file locations.");
  return path.resolve(parsed.fsPath);
}

function sameRange(left: LspRange, right: LspRange): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}
function declarationNames(
  symbols: readonly LspDocumentSymbol[],
  name: string,
  range: LspRange,
): LspRange[] {
  return symbols.flatMap((symbol) => [
    ...(symbol.name === name &&
    symbol.range !== undefined &&
    sameRange(symbol.range, range) &&
    symbol.selectionRange !== undefined
      ? [symbol.selectionRange]
      : []),
    ...declarationNames(symbol.children ?? [], name, range),
  ]);
}
/** Search workspace declarations/references, keeping real provider ranges and honest completeness. */
export async function searchSymbols(
  query: string,
  cwd: string,
  limit: number,
  signal?: AbortSignal,
  scope: SymbolSearchScope = {},
  manager = LspManager.getInstance(),
): Promise<{ readonly hits: SymbolHit[]; readonly complete: boolean }> {
  signal?.throwIfAborted();
  const resultScope = scope.resultScope;
  if (resultScope !== undefined) {
    await verifyResultTargets(resultScope, signal);
    if (resultScope.targets.length === 0) return { hits: [], complete: resultScope.complete };
  }
  const roots = resultScope?.targets.map((target) => target.source) ?? [scope.path ?? cwd];
  const clients = new Set(
    (await Promise.all(roots.map((root) => manager.prepareWorkspaceSymbols(cwd, root)))).flat(),
  );
  if (clients.size === 0)
    throw new Error("LSP symbol search is unavailable: no configured provider for this scope.");
  const contents = new Map<string, ReturnType<typeof createTextDocument>>();
  const toMatch = async (location: LspLocation): Promise<SearchSelectionMatch> => {
    signal?.throwIfAborted();
    const source = sourceOf(location.uri);
    let document = contents.get(source);
    if (document === undefined) {
      const before = await stat(source);
      const content = await readFile(source, { encoding: "utf8", signal });
      const after = await stat(source);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
        throw new Error("LSP source changed during search.");
      document = createTextDocument(source, content);
      contents.set(source, document);
    }
    const { start, end } = location.range;
    const positions = [start, end];
    for (const position of positions) {
      const line = document.lines[position.line];
      if (
        !Number.isInteger(position.line) ||
        !Number.isInteger(position.character) ||
        line === undefined ||
        position.character < 0 ||
        position.character > line.content.length
      )
        throw new Error("LSP range does not match its source snapshot.");
    }
    const first = requiredValue(document.lines[start.line]);
    const offset = (line: number) =>
      document.lines
        .slice(0, line)
        .reduce((total, row) => total + row.content.length + row.lineEnding.length, 0);
    const from = offset(start.line) + start.character;
    const to = offset(end.line) + end.character;
    if (to < from) throw new Error("LSP returned a reversed source range.");
    return {
      source,
      lineNumber: start.line + 1,
      endLineNumber: end.line + 1,
      startColumn: start.character,
      endColumn: end.character,
      matchedText: document.content.slice(from, to),
      lineText: first.content,
    };
  };
  const included = (hit: SearchSelectionMatch) =>
    withinPath(hit.source, cwd, scope) &&
    (resultScope === undefined || containsSearchMatch(resultScope, hit));
  const hits: SymbolHit[] = [];
  const seen = new Set<string>();
  for (const client of clients) {
    signal?.throwIfAborted();
    const definitions = await requestWorkspaceSymbols(client, query, Number.MAX_SAFE_INTEGER);
    for (const definition of definitions) {
      signal?.throwIfAborted();
      const workspaceMatch = await toMatch(definition.location);
      const opened = await manager.openFile(workspaceMatch.source, cwd, "symbols");
      if (opened === null)
        throw new Error("LSP references are unavailable for a discovered declaration.");
      let location = definition.location;
      if (workspaceMatch.matchedText !== definition.name) {
        const symbols = await requestDocumentSymbols(opened.client, opened.uri);
        const names = declarationNames(symbols, definition.name, definition.location.range);
        if (names.length !== 1)
          throw new Error(
            "LSP declaration has no unique provider selectionRange; cannot search its references.",
          );
        location = { uri: opened.uri, range: requiredValue(names[0]) };
      }
      const declared = await toMatch(location);
      const symbol: SearchSymbol = {
        id: JSON.stringify([client.serverId, declared.source, definition.location.range]),
        name: definition.name,
        kind: String(definition.kind),
        source: declared.source,
        range: {
          startLine: declared.lineNumber,
          startColumn: declared.startColumn,
          endLine: declared.endLineNumber ?? declared.lineNumber,
          endColumn: declared.endColumn,
        },
      };
      const references = await requestReferences(opened.client, opened.uri, location.range.start);
      signal?.throwIfAborted();
      const candidates: SymbolHit[] = [{ ...declared, role: "definition", symbol }];
      for (const location of references) {
        const reference = await toMatch(location);
        if (
          reference.source === declared.source &&
          reference.lineNumber === declared.lineNumber &&
          reference.startColumn === declared.startColumn &&
          reference.endLineNumber === declared.endLineNumber &&
          reference.endColumn === declared.endColumn
        )
          continue;
        candidates.push({ ...reference, role: "reference", symbol });
      }
      if (scope.navigation === "references" && !candidates.some(included)) continue;
      for (const hit of candidates) {
        if (scope.navigation !== "references" && !included(hit)) continue;
        // Navigation can leave the seed region, never the workspace source-access boundary.
        if (scope.navigation === "references" && !withinPath(hit.source, cwd, {})) continue;
        const key = JSON.stringify([
          symbol.id,
          hit.source,
          hit.lineNumber,
          hit.startColumn,
          hit.endLineNumber,
          hit.endColumn,
        ]);
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(hit);
      }
    }
  }
  signal?.throwIfAborted();
  for (const [source, document] of contents) {
    if ((await readFile(source, { encoding: "utf8", signal })) !== document.content)
      throw new Error("LSP source changed during search.");
  }
  if (resultScope !== undefined) await verifyResultTargets(resultScope, signal);
  hits.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.lineNumber - right.lineNumber ||
      left.startColumn - right.startColumn ||
      left.endColumn - right.endColumn ||
      left.symbol.id.localeCompare(right.symbol.id),
  );
  return {
    hits: hits.slice(0, limit),
    complete: (resultScope?.complete ?? true) && hits.length <= limit,
  };
}
