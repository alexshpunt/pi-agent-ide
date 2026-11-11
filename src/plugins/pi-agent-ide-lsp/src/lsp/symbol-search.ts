import path from "node:path";
import { LinePositionMap } from "./position-map.ts";
import { retryWhileSourceChanges, sourceChanged } from "./source-changes.ts";
import { requiredValue } from "pi-agent-invariant";
import { URI } from "vscode-uri";
import { documentUri } from "./document-uri.ts";
import { createTextDocument } from "pi-agent-text";
import { resultTargetsInText, type ResolvedResultTargets } from "pi-agent-resource";
import {
  containsSearchMatch,
  splitGlobList,
  type SearchSelectionMatch,
} from "pi-agent-search/api/search";

import { LspManager } from "./manager.ts";
import type { LspClient } from "./client.ts";
import { requestReferences, type LspLocation } from "./navigation.ts";
import { diagnosticErrors, textInRange, withoutCorrectedNames } from "./corrected-names.ts";
import type { LspPosition } from "./types.ts";
import {
  clangCoverage,
  coverageComplete,
  createClangReach,
  mergeCoverage,
  type ClangCoverage,
} from "./clang-coverage.ts";
import { requestWorkspaceSymbols, requestDocumentSymbols } from "./symbols.ts";
import {
  bodyEntry,
  declarationAt,
  declarationsNamed,
  normalizeDocumentSymbols,
  type LspCodeSymbol,
} from "./symbol-selectors.ts";

/** Strict discovery scope, or an explicit seed scope for reference navigation. */
export interface SymbolSearchScope {
  readonly path?: string;
  /** Several files and directories in place of `path`; a hit inside any of them is in scope. */
  readonly paths?: readonly string[];
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
  /** Selector segments that name this declaration alone in its file, such as `clamp(int, int)`. */
  readonly selector?: readonly string[];
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

/** Whether `file` is inside the workspace `cwd` and the path, include and exclude of `scope`. */
export function withinScope(file: string, cwd: string, scope: SymbolSearchScope): boolean {
  const remote = cwd.startsWith("ssh://");
  const filesystem = remote ? path.posix : path;
  const native = (source: string) =>
    remote ? decodeURIComponent(new URL(documentUri(source, cwd)).pathname) : source;
  const inside = (root: string | undefined) => {
    const base = remote ? native(root ?? cwd) : path.resolve(cwd, root ?? ".");
    const relative = filesystem.relative(base, native(file));
    return !(
      // oxlint-disable-next-line repo/no-parent-paths -- containment check only.
      relative === ".." ||
      relative.startsWith(`..${filesystem.sep}`) ||
      filesystem.isAbsolute(relative)
    );
  };
  if (!(scope.paths ?? [scope.path]).some(inside)) return false;
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

/** Symbols found by {@link searchSymbols}. */
export interface SymbolSearchResult {
  readonly hits: SymbolHit[];
  readonly complete: boolean;
  /** Why C/C++ references can be missing; present only when they can. */
  readonly coverage?: ClangCoverage;
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
  if (resultScope?.targets.length === 0) return { hits: [], complete: resultScope.complete };
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
  const roots = resultScope?.targets.map((target) => target.source) ??
    scope.paths ?? [scope.path ?? cwd];
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
  // The result scope as the text each hit was read from. Another session may have written the file
  // since the scope was resolved, before or while the server answered; the scope follows its
  // region through unchanged lines, and the call fails when the region is gone.
  const scopeIn = new Map<string, ResolvedResultTargets>();
  // One line diff per file and served text: a pass maps many ranges of the same two texts.
  const diffs = new Map<
    string,
    { served: string; toSnapshot?: LinePositionMap; toServed?: LinePositionMap }
  >();
  const lineDiff = (
    source: string,
    served: string,
    snapshot: string,
    direction: "toSnapshot" | "toServed",
  ): LinePositionMap => {
    let entry = diffs.get(source);
    if (entry === undefined || entry.served !== served) {
      entry = { served };
      diffs.set(source, entry);
    }
    return (entry[direction] ??=
      direction === "toSnapshot"
        ? LinePositionMap.between(served, snapshot)
        : LinePositionMap.between(snapshot, served));
  };
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
      if (resultScope !== undefined)
        scopeIn.set(
          source,
          resultTargetsInText(
            {
              targets: resultScope.targets.filter((target) => target.source === source),
              complete: resultScope.complete,
            },
            new Map([[source, content]]),
          ),
        );
    }
    const { document } = snapshot;
    const served = client?.documentContent(location.uri);
    const range =
      served === undefined || served === document.content
        ? location.range
        : lineDiff(source, served, document.content, "toSnapshot").mapRange(location.range);
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
  /**
   * The declaration's position in the text the server holds now. Our own reads keep the server in
   * step with the file, so a position of the text a declaration was read from can name another
   * line in the server's text after another session wrote the file; the server then reports no
   * references there. The position follows its unchanged line into the served text instead, and
   * the call runs again when that line is gone.
   */
  const servedPosition = (
    client: { documentContent(uri: string): string | undefined },
    uri: string,
    declaration: SearchSelectionMatch,
  ): LspPosition => {
    const start = { line: declaration.lineNumber - 1, character: declaration.startColumn };
    const served = client.documentContent(uri);
    const snapshot = contents.get(declaration.source)?.document.content;
    if (served === undefined || snapshot === undefined || served === snapshot) return start;
    const range = {
      start,
      end: {
        line: (declaration.endLineNumber ?? declaration.lineNumber) - 1,
        character: declaration.endColumn,
      },
    };
    const mapped = lineDiff(declaration.source, served, snapshot, "toServed").mapRange(range);
    if (mapped === undefined || textInRange(served, mapped) !== declaration.matchedText)
      throw sourceChanged(
        `The line of declaration "${declaration.matchedText}" changed before the server was asked for its references.`,
      );
    return mapped.start;
  };
  const included = (hit: SearchSelectionMatch) =>
    withinScope(hit.source, cwd, scope) &&
    (resultScope === undefined || containsSearchMatch(requiredValue(scopeIn.get(hit.source)), hit));
  const hits: SymbolHit[] = [];
  const seen = new Set<string>();
  const errorsOf = diagnosticErrors(
    (uri) => manager.openFile(sourceOf(uri, cwd), cwd, "symbols", signal),
    signal,
  );
  // A search with references can leave its scope; without them it lists only hits inside it.
  const reachOf = createClangReach({
    manager,
    cwd,
    errorsOf,
    accepts: (source) =>
      scope.navigation === "references"
        ? withinScope(source, cwd, {})
        : withinScope(source, cwd, scope) &&
          (resultScope === undefined ||
            resultScope.targets.some((target) => target.source === source)),
    ...(signal && { signal }),
  });
  const coverages: (ClangCoverage | undefined)[] = [];
  // Declarations already listed, by file and the name position of their first entry.
  const listed = new Set<string>();
  const outlines = new Map<string, Promise<LspCodeSymbol[]>>();
  const outlineOf = (client: LspClient, uri: string) => {
    let outline = outlines.get(uri);
    if (outline === undefined) {
      outline = requestDocumentSymbols(client, uri, signal).then(normalizeDocumentSymbols);
      outlines.set(uri, outline);
    }
    return outline;
  };
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
      // The server's symbol index can lag behind edits, so its range may belong to an older text.
      // The file's current symbols then name every declaration with that name, each overload
      // apart; a prototype and its definition are one declaration.
      const outline = await outlineOf(opened.client, opened.uri);
      const fresh = workspaceMatch?.matchedText === definition.name;
      const declarations: (readonly LspCodeSymbol[] | undefined)[] = fresh
        ? [declarationAt(outline, definition.location.range)]
        : declarationsNamed(outline, definition.name);
      if (declarations.length === 0)
        throw sourceChanged(
          `LSP declaration "${definition.name}" is not among the current symbols of its file.`,
        );
      for (const entries of declarations) {
        signal?.throwIfAborted();
        // A declaration's references and renames are the same from each of its entries; its
        // definition is the one listed.
        const entry =
          entries === undefined
            ? undefined
            : (bodyEntry(
                entries,
                opened.client.documentContent(opened.uri) ??
                  (await manager.readSourceText(sourceOf(opened.uri, cwd), signal)),
              ) ?? entries[0]);
        const location =
          entry === undefined
            ? definition.location
            : { uri: opened.uri, range: entry.selectionRange };
        const identity = JSON.stringify([
          opened.uri,
          (entries?.[0]?.selectionRange ?? definition.location.range).start,
        ]);
        if (listed.has(identity)) continue;
        listed.add(identity);
        const declared = await toMatch(location, opened.client);
        const symbol: SearchSymbol = {
          id: JSON.stringify([client.serverId, declared.source, location.range]),
          name: entry?.name ?? definition.name,
          kind: String(entry?.kind ?? definition.kind),
          ...(entry !== undefined && { selector: entry.selector }),
          source: declared.source,
          range: {
            startLine: declared.lineNumber,
            startColumn: declared.startColumn,
            endLine: declared.endLineNumber ?? declared.lineNumber,
            endColumn: declared.endColumn,
          },
        };
        const reach = await reachOf(opened.client, opened.languageId, symbol.name);
        const servedBefore = opened.client.documentContent(opened.uri);
        const requestPosition = servedPosition(opened.client, opened.uri, declared);
        const references = await requestReferences(
          opened.client,
          opened.uri,
          requestPosition,
          signal,
        );
        // An answer for a text the server replaced while answering fits neither text.
        if (opened.client.documentContent(opened.uri) !== servedBefore)
          throw sourceChanged("The server's text changed while it answered a references request.");
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
          [symbol.name, declared.matchedText],
          errorsOf,
        );
        for (const { reference } of named)
          candidates.push({ ...reference, role: "reference", symbol });
        if (!candidates.some(included)) continue;
        // Only symbols that contribute hits decide what the result can be missing.
        if (reach !== undefined)
          coverages.push(
            await clangCoverage(
              reach,
              [opened.uri, ...reported.map(({ location }) => location.uri)],
              errorsOf,
              (uri) => sourceOf(uri, cwd),
            ),
          );
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
  hits.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.lineNumber - right.lineNumber ||
      left.startColumn - right.startColumn ||
      left.endColumn - right.endColumn ||
      left.symbol.id.localeCompare(right.symbol.id),
  );
  const coverage = mergeCoverage(coverages);
  return {
    hits: hits.slice(0, limit),
    complete: (resultScope?.complete ?? true) && hits.length <= limit && coverageComplete(coverage),
    ...(coverage !== undefined && !coverageComplete(coverage) && { coverage }),
  };
}
