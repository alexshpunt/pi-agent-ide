import path from "node:path";
import { LinePositionMap } from "./position-map.ts";
import { retryWhileSourceChanges, sourceChanged } from "./source-changes.ts";
import { requiredValue } from "pi-agent-invariant";
import { URI } from "vscode-uri";
import { documentUri } from "./document-uri.ts";
import { createTextDocument } from "pi-agent-text";
import { verifyResultTargets, type ResolvedResultTargets } from "pi-agent-resource";
import {
  containsSearchMatch,
  splitGlobList,
  type SearchSelectionMatch,
} from "pi-agent-search/api/search";

import { LspManager } from "./manager.ts";
import { requestReferences, type LspLocation } from "./navigation.ts";
import {
  diagnosticErrors,
  documentsPastErrorLimit,
  withoutCorrectedNames,
} from "./corrected-names.ts";
import {
  requestWorkspaceSymbols,
  requestDocumentSymbols,
  type LspDocumentSymbol,
} from "./symbols.ts";
import type { LspRange } from "./types.ts";

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

function withinScope(file: string, cwd: string, scope: SymbolSearchScope): boolean {
  const remote = cwd.startsWith("ssh://");
  const filesystem = remote ? path.posix : path;
  const native = (source: string) =>
    remote ? decodeURIComponent(new URL(documentUri(source, cwd)).pathname) : source;
  const base = remote ? native(scope.path ?? cwd) : path.resolve(cwd, scope.path ?? ".");
  const relative = filesystem.relative(base, native(file));
  if (
    // oxlint-disable-next-line repo/no-parent-paths -- containment check only.
    relative === ".." ||
    relative.startsWith(`..${filesystem.sep}`) ||
    filesystem.isAbsolute(relative)
  )
    return false;
  const candidate = filesystem.relative(native(cwd), native(file)).split(filesystem.sep).join("/");
  const matches = (patterns: string) =>
    splitGlobList(patterns).some((glob) =>
      filesystem.matchesGlob(
        glob.includes("/") ? candidate : filesystem.basename(native(file)),
        glob,
      ),
    );
  return (
    (scope.include === undefined || matches(scope.include)) &&
    (scope.exclude === undefined || !matches(scope.exclude))
  );
}
function sourceOf(uri: string, cwd: string): string {
  const canonical = documentUri(uri, cwd);
  if (canonical.startsWith("ssh://")) return canonical;
  const parsed = URI.parse(canonical);
  if (parsed.scheme !== "file") throw new Error("Unsupported LSP source location.");
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
function declarationsNamed(symbols: readonly LspDocumentSymbol[], name: string): LspRange[] {
  return symbols.flatMap((symbol) => [
    ...(symbol.name === name && symbol.selectionRange !== undefined ? [symbol.selectionRange] : []),
    ...declarationsNamed(symbol.children ?? [], name),
  ]);
}
/** Symbols found by {@link searchSymbols}. */
export interface SymbolSearchResult {
  readonly hits: SymbolHit[];
  readonly complete: boolean;
  /** Searched files where the compiler stopped at its error limit, so references can be missing. */
  readonly pastErrorLimit?: readonly string[];
}

/** Search workspace declarations/references, keeping real provider ranges and honest completeness. */
export async function searchSymbols(
  query: string,
  cwd: string,
  limit: number,
  signal?: AbortSignal,
  scope: SymbolSearchScope = {},
  manager = LspManager.getInstance(),
): Promise<SymbolSearchResult> {
  // Another Pi process may edit a searched file while the server answers. Its ranges then fit
  // neither version, so search again on the current text.
  return retryWhileSourceChanges(
    () => searchSymbolsOnce(query, cwd, limit, signal, scope, manager),
    signal,
  );
}

async function searchSymbolsOnce(
  query: string,
  cwd: string,
  limit: number,
  signal: AbortSignal | undefined,
  scope: SymbolSearchScope,
  manager: LspManager,
): Promise<SymbolSearchResult> {
  signal?.throwIfAborted();
  const resultScope = scope.resultScope;
  if (resultScope !== undefined) {
    await verifyResultTargets(resultScope, signal);
    if (resultScope.targets.length === 0) return { hits: [], complete: resultScope.complete };
  }
  if (
    resultScope === undefined &&
    scope.path !== undefined &&
    !withinScope(
      cwd.startsWith("ssh://") ? documentUri(scope.path, cwd) : path.resolve(cwd, scope.path),
      cwd,
      scope,
    ) &&
    (await manager.isSourceFile(scope.path, cwd, signal))
  )
    return { hits: [], complete: true };
  const roots = resultScope?.targets.map((target) => target.source) ?? [scope.path ?? cwd];
  const clients = new Set(
    (
      await Promise.all(
        roots.map((root) =>
          manager.prepareWorkspaceSymbols(
            cwd,
            root,
            (source) => withinScope(source, cwd, scope),
            signal,
          ),
        ),
      )
    ).flat(),
  );
  if (clients.size === 0)
    throw new Error(
      "LSP symbol search is unavailable: no provider supports workspace/symbol in this scope.",
    );
  const contents = new Map<
    string,
    { document: ReturnType<typeof createTextDocument>; version: string }
  >();
  // A server answers for the text its client synced. Another Pi process may have written the
  // file since; ranges then move with their unchanged lines to the file text read here.
  const toMatch = async (
    location: LspLocation,
    client?: { documentContent(uri: string): string | undefined },
  ): Promise<SearchSelectionMatch> => {
    signal?.throwIfAborted();
    const source = sourceOf(location.uri, cwd);
    let snapshot = contents.get(source);
    if (snapshot === undefined) {
      const { content, version } = await manager.readSourceSnapshot(source, signal);
      snapshot = { document: createTextDocument(source, content), version };
      contents.set(source, snapshot);
    }
    const { document } = snapshot;
    const served = client?.documentContent(location.uri);
    const range =
      served === undefined || served === document.content
        ? location.range
        : LinePositionMap.between(served, document.content).mapRange(location.range);
    if (range === undefined) throw sourceChanged("LSP range does not match its source snapshot.");
    const { start, end } = range;
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
        throw sourceChanged("LSP range does not match its source snapshot.");
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
    withinScope(hit.source, cwd, scope) &&
    (resultScope === undefined || containsSearchMatch(resultScope, hit));
  const hits: SymbolHit[] = [];
  const seen = new Set<string>();
  const errorsOf = diagnosticErrors(
    (uri) => manager.openFile(sourceOf(uri, cwd), cwd, "symbols", signal),
    signal,
  );
  const pastErrorLimit = new Set<string>();
  for (const client of clients) {
    signal?.throwIfAborted();
    const definitions = await requestWorkspaceSymbols(
      client,
      query,
      Number.MAX_SAFE_INTEGER,
      signal,
    );
    for (const definition of definitions) {
      signal?.throwIfAborted();
      if (!withinScope(sourceOf(definition.location.uri, cwd), cwd, {})) continue;
      // The server's symbol index can lag behind edits; a stale position is looked up by name.
      const workspaceMatch = await toMatch(definition.location, client).catch((error: unknown) => {
        if ((error as { code?: unknown } | null)?.code === "SOURCE_CHANGED") return undefined;
        throw error;
      });
      const opened = await manager.openFile(
        sourceOf(definition.location.uri, cwd),
        cwd,
        "symbols",
        signal,
      );
      if (opened === null)
        throw new Error("LSP references are unavailable for a discovered declaration.");
      let location = definition.location;
      if (workspaceMatch?.matchedText !== definition.name) {
        const symbols = await requestDocumentSymbols(opened.client, opened.uri, signal);
        let names = declarationNames(symbols, definition.name, definition.location.range);
        // The server's symbol index can lag behind edits, so its range may belong to an older
        // text. A name declared once in the file still identifies the declaration.
        if (names.length !== 1) names = declarationsNamed(symbols, definition.name);
        if (names.length !== 1)
          throw sourceChanged(
            "LSP declaration has no unique provider selectionRange; cannot search its references.",
          );
        location = { uri: opened.uri, range: requiredValue(names[0]) };
      }
      const declared = await toMatch(location, opened.client);
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
      const references = await requestReferences(
        opened.client,
        opened.uri,
        location.range.start,
        signal,
      );
      signal?.throwIfAborted();
      const candidates: SymbolHit[] = [{ ...declared, role: "definition", symbol }];
      const reported: { location: LspLocation; reference: SearchSelectionMatch }[] = [];
      for (const location of references) {
        if (!withinScope(sourceOf(location.uri, cwd), cwd, {})) continue;
        const reference = await toMatch(location, opened.client);
        if (
          reference.source === declared.source &&
          reference.lineNumber === declared.lineNumber &&
          reference.startColumn === declared.startColumn &&
          reference.endLineNumber === declared.endLineNumber &&
          reference.endColumn === declared.endColumn
        )
          continue;
        reported.push({ location, reference });
      }
      const named = await withoutCorrectedNames(
        reported,
        ({ location, reference }) => ({
          uri: location.uri,
          start: location.range.start,
          text: reference.matchedText,
        }),
        [definition.name, declared.matchedText],
        errorsOf,
      );
      // The server answers from the syntax trees of the declaration file and of files it has
      // open; one past the compiler's error limit can lack references.
      for (const uri of documentsPastErrorLimit(opened.client, [
        opened.uri,
        ...reported.map(({ location }) => location.uri),
      ]))
        pastErrorLimit.add(sourceOf(uri, cwd));
      for (const { reference } of named)
        candidates.push({ ...reference, role: "reference", symbol });
      if (scope.navigation === "references" && !candidates.some(included)) continue;
      for (const hit of candidates) {
        if (scope.navigation !== "references" && !included(hit)) continue;
        // Navigation can leave the seed region, never the workspace source-access boundary.
        if (scope.navigation === "references" && !withinScope(hit.source, cwd, {})) continue;
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
  // Files edited during the search keep the hits whose lines are unchanged, at their new lines.
  const moved = new Map<string, LinePositionMap>();
  for (const [source, snapshot] of contents) {
    const current = await manager.readSourceSnapshot(source, signal);
    if (current.version !== snapshot.version && current.content !== snapshot.document.content)
      moved.set(source, LinePositionMap.between(snapshot.document.content, current.content));
  }
  for (const [index, hit] of hits.entries()) {
    const map = moved.get(hit.source);
    if (map === undefined) continue;
    const range = map.mapRange({
      start: { line: hit.lineNumber - 1, character: hit.startColumn },
      end: { line: (hit.endLineNumber ?? hit.lineNumber) - 1, character: hit.endColumn },
    });
    if (range === undefined) throw sourceChanged("LSP source changed during search.");
    hits[index] = { ...hit, lineNumber: range.start.line + 1, endLineNumber: range.end.line + 1 };
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
    complete: (resultScope?.complete ?? true) && hits.length <= limit && pastErrorLimit.size === 0,
    ...(pastErrorLimit.size > 0 && { pastErrorLimit: [...pastErrorLimit].sort() }),
  };
}
