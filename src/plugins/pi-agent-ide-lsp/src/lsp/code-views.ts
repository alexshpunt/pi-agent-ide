import { requiredValue } from "pi-agent-invariant";
import { LinePositionMap } from "./position-map.ts";
import { retryWhileSourceChanges, sourceChanged } from "./source-changes.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatCodeViewReference,
  resolveCodeViewPath,
  formatSymbolSelector,
} from "pi-agent-ide/api/code-view";

import { requestCallHierarchy, requestReferences } from "./navigation.ts";
import { requestDocumentSymbols, symbolKindName } from "./symbols.ts";
import {
  diagnosticErrors,
  textInRange,
  withoutCorrectedNames,
  type DocumentErrorsProvider,
} from "./corrected-names.ts";
import {
  CLANG_LANGUAGES,
  clangCoverage,
  coverageNotes,
  createClangReach,
  mergeCoverage,
  type ClangCoverage,
  type ClangReachProvider,
} from "./clang-coverage.ts";
import { withinScope } from "./symbol-search.ts";
import {
  declarationBody,
  normalizeDocumentSymbols,
  resolveSymbolDeclaration,
  type LspCodeSymbol,
} from "./symbol-selectors.ts";

import type { LspClient } from "./client.ts";
import type { LspManager } from "./manager.ts";
import type {
  LspCallDirection,
  LspCallHierarchyResult,
  LspIncomingCall,
  LspLocation,
  LspOutgoingCall,
} from "./navigation.ts";
import type { LspRange } from "./types.ts";

const MAX_GROUPS = 10;
const MAX_ITEMS_PER_GROUP = 5;
const MAX_CALLS = 10;

export type { LspCodeSymbol } from "./symbol-selectors.ts";

interface LspCodeDocument {
  readonly client: LspClient;
  readonly uri: string;
  readonly filePath: string;
  readonly displayPath: string;
  readonly symbols: readonly LspCodeSymbol[];
  /** Text the server answered for, or undefined when the client holds none. */
  readonly servedText: string | undefined;
  readonly languageId: string;
}

/** Resolve a declaration's exact server range for guarded text operations. */
export async function resolveLspDeclaration(
  manager: LspManager,
  filePath: string,
  selector: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ readonly source: string; readonly range: LspRange; readonly content: string }> {
  // Another Pi process may write the file while the server reports its symbols.
  return retryWhileSourceChanges(
    () => resolveLspDeclarationOnce(manager, filePath, selector, cwd, signal),
    signal,
  );
}

async function resolveLspDeclarationOnce(
  manager: LspManager,
  filePath: string,
  selector: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ readonly source: string; readonly range: LspRange; readonly content: string }> {
  throwIfAborted(signal);
  const document = await openCodeDocument(manager, filePath, cwd, signal);
  const entries = resolveSymbolDeclaration(document.symbols, selector, document.displayPath);
  const current = await manager.readSourceText(document.filePath, signal);
  throwIfAborted(signal);
  // A text edit acts on the definition, not on its prototype.
  const symbol = declarationBody(entries, document.servedText ?? current, document.displayPath);
  // Other Pi processes may have edited the file while the server answered, and on a shared
  // server another session's newer text may be what it answered for. The text where the name
  // sits at the reported position is the one the ranges belong to; the declaration then moves
  // with its unchanged lines, and one whose own lines changed is resolved again.
  const served = document.servedText;
  const range =
    served === current || answeredFor(current, symbol)
      ? symbol.range
      : served !== undefined && answeredFor(served, symbol)
        ? LinePositionMap.between(served, current).mapRange(symbol.range)
        : undefined;
  if (range === undefined)
    throw sourceChanged(
      "The symbol source changed during resolution. Read it again before editing.",
    );
  return { source: document.filePath, range, content: current };
}
/** Resolve the native identifier position and client without guessing from declaration text. */
export async function resolveLspRenameTarget(
  manager: LspManager,
  filePath: string,
  selector: readonly string[],
  cwd: string,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const content = await manager.readSourceText(filePath, signal);
  const document = await openCodeDocument(manager, filePath, cwd, signal);
  const symbol = resolveLspCodeSymbol(document.symbols, selector, document.displayPath);
  if (content !== (await manager.readSourceText(filePath, signal)))
    throw sourceChanged("The rename source changed during resolution.");
  throwIfAborted(signal);
  return {
    client: document.client,
    uri: document.uri,
    position: symbol.selectionRange.start,
    name: symbol.name,
    content,
  };
}
interface SymbolRelations {
  readonly references: readonly LspLocation[];
  readonly calls: LspCallHierarchyResult;
  /** Why C/C++ references and callers can be missing. */
  readonly coverage: ClangCoverage | undefined;
}

/** Diagnostics and opened files shared by the queries of one graph. */
interface RelationContext {
  readonly errorsOf: DocumentErrorsProvider;
  /** Opens the files that write a name; omitted, only files already open are checked. */
  readonly reachOf?: ClangReachProvider;
}

function relationContext(
  manager: LspManager,
  cwd: string,
  openFiles: boolean,
  signal: AbortSignal | undefined,
): RelationContext {
  const errorsOf = diagnosticErrors(
    (uri) => manager.openFile(fileOf(uri), cwd, "symbols", signal),
    signal,
  );
  return {
    errorsOf,
    ...(openFiles && {
      reachOf: createClangReach({
        manager,
        cwd,
        errorsOf,
        accepts: (source) => withinScope(source, cwd, {}),
        ...(signal && { signal }),
      }),
    }),
  };
}

function fileOf(uri: string): string {
  return uri.startsWith("ssh://") ? uri : fileURLToPath(uri);
}

export async function readLspSymbolGraph(
  manager: LspManager,
  filePath: string,
  selector: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  return retryWhileSourceChanges(async () => {
    throwIfAborted(signal);
    const document = await openCodeDocument(manager, filePath, cwd, signal);
    const symbol = resolveLspCodeSymbol(document.symbols, selector, document.displayPath);
    const relations = await queryRelations(
      manager,
      document,
      symbol,
      relationContext(manager, cwd, true, signal),
      signal,
    );
    const locations = new LocationPresenter(cwd);
    const graph = await formatSymbolGraph(document, symbol, relations, locations);
    await assertAnsweredForCurrentText(manager, document, signal);
    return graph;
  }, signal);
}

/**
 * Graph lines carry the server's line numbers of the current file. When another
 * process edited the file while the server answered, those numbers can name other lines.
 */
async function assertAnsweredForCurrentText(
  manager: LspManager,
  document: LspCodeDocument,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (document.servedText === undefined) return;
  const current = await manager.readSourceText(document.filePath, signal);
  if (document.servedText !== current)
    throw sourceChanged("The file changed while the language server answered. Read it again.");
}

export async function readLspFileGraph(
  manager: LspManager,
  filePath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  return retryWhileSourceChanges(async () => {
    throwIfAborted(signal);
    const document = await openCodeDocument(manager, filePath, cwd, signal);
    const locations = new LocationPresenter(cwd);
    const lines = [
      `## file graph: ${document.displayPath}`,
      `Top-level declarations: ${document.symbols.length}`,
    ];
    // A file graph queries every declaration; looking up each name in the workspace would take
    // minutes in a large project, so it checks only the files that are already open.
    const context = relationContext(manager, cwd, false, signal);
    const coverages: (ClangCoverage | undefined)[] = [];

    for (const symbol of document.symbols) {
      throwIfAborted(signal);
      const relations = await queryRelations(manager, document, symbol, context, signal);
      coverages.push(relations.coverage);
      lines.push("", ...(await formatFileGraphSymbol(document, symbol, relations, locations)));
    }
    lines.splice(
      2,
      0,
      ...coverageNotes(mergeCoverage(coverages), (source) => locations.display(source)),
    );

    await assertAnsweredForCurrentText(manager, document, signal);
    return lines.join("\n");
  }, signal);
}

/** The entry of the declaration `selector` names whose position navigation requests use. */
export function resolveLspCodeSymbol(
  symbols: readonly LspCodeSymbol[],
  selector: readonly string[],
  displayPath: string,
): LspCodeSymbol {
  // A prototype and its definition answer references, calls and renames alike.
  return requiredValue(resolveSymbolDeclaration(symbols, selector, displayPath)[0]);
}

async function openCodeDocument(
  manager: LspManager,
  filePath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<LspCodeDocument> {
  const absolutePath = resolveCodeViewPath(filePath, cwd);
  const opened = await manager.openFile(absolutePath, cwd, "symbols", signal);

  if (!opened) {
    throw new Error(
      `No LSP server with symbol support is configured for ${displayFilePath(absolutePath, cwd)}.`,
    );
  }

  const servedText = opened.client.documentContent(opened.uri);
  const rawSymbols = await requestDocumentSymbols(opened.client, opened.uri, signal);
  const symbols = normalizeDocumentSymbols(rawSymbols);
  return {
    client: opened.client,
    uri: opened.uri,
    filePath: absolutePath,
    displayPath: displayFilePath(absolutePath, cwd),
    symbols,
    servedText,
    languageId: opened.languageId,
  };
}

async function queryRelations(
  manager: LspManager,
  document: LspCodeDocument,
  symbol: LspCodeSymbol,
  context: RelationContext,
  signal: AbortSignal | undefined,
): Promise<SymbolRelations> {
  const position = symbol.selectionRange.start;
  const { errorsOf } = context;
  const reach = CLANG_LANGUAGES.has(document.languageId)
    ? ((await context.reachOf?.(document.client, document.languageId, symbol.name)) ?? {
        client: document.client,
        opened: [],
        unopened: 0,
        unlisted: false,
      })
    : undefined;
  const [references, calls] = await Promise.all([
    requestReferences(document.client, document.uri, position, signal),
    requestCallHierarchy(document.client, document.uri, position, signal),
  ]);
  throwIfAborted(signal);
  const contents = new Map<string, Promise<string>>();
  const contentOf = (uri: string) => {
    let content = contents.get(uri);
    if (content === undefined) {
      const served = document.client.documentContent(uri);
      content =
        served === undefined
          ? manager.readSourceText(fileOf(uri), signal)
          : Promise.resolve(served);
      contents.set(uri, content);
    }
    return content;
  };
  const names = [symbol.name, textInRange(document.servedText ?? "", symbol.selectionRange)];
  const named = async <T>(items: readonly T[], locate: (item: T) => LspLocation) =>
    items.length === 0
      ? []
      : (
          await withoutCorrectedNames(
            await Promise.all(
              items.map(async (item) => {
                const location = locate(item);
                return {
                  item,
                  uri: location.uri,
                  start: location.range.start,
                  text: textInRange(await contentOf(location.uri), location.range),
                };
              }),
            ),
            (reported) => reported,
            names,
            errorsOf,
          )
        ).map(({ item }) => item);
  const incoming = await Promise.all(
    calls.incoming.map(async (call) => ({
      ...call,
      fromRanges: await named(call.fromRanges, (range) => ({ uri: call.from.uri, range })),
    })),
  );
  return {
    references: await named(references, (location) => location),
    coverage:
      reach &&
      (await clangCoverage(
        reach,
        [
          document.uri,
          ...references.map((location) => location.uri),
          ...calls.incoming.map((call) => call.from.uri),
        ],
        errorsOf,
        fileOf,
      )),
    calls: {
      ...calls,
      // A caller is listed for the places it calls the symbol; one left without any is not.
      incoming: incoming.filter(
        (call, index) =>
          call.fromRanges.length > 0 || calls.incoming[index]?.fromRanges.length === 0,
      ),
    },
  };
}

async function formatSymbolGraph(
  document: LspCodeDocument,
  symbol: LspCodeSymbol,
  relations: SymbolRelations,
  locations: LocationPresenter,
): Promise<string> {
  const selector = formatSymbolSelector(symbol.selector);
  const definitionAnchor = await locations.line(document.uri, symbol.selectionRange.start.line + 1);
  const lines = [
    `## graph: ${selector}`,
    `Definition: ${document.displayPath} ${definitionAnchor} (${symbolKindName(symbol.kind)})`,
    `Source: calls ${callsReference(document.displayPath, symbol.selector)}`,
    ...coverageNotes(relations.coverage, (source) => locations.display(source)),
    "",
    ...(await formatReferences(relations.references, locations)),
    "",
    ...(unsupportedCalls(document, relations, "incoming") ??
      (await formatIncomingCalls(relations.calls.incoming, locations))),
    "",
    ...(unsupportedCalls(document, relations, "outgoing") ??
      (await formatOutgoingCalls(relations.calls.outgoing, locations))),
  ];
  return lines.join("\n");
}

async function formatReferences(
  references: readonly LspLocation[],
  locations: LocationPresenter,
): Promise<string[]> {
  const groups = groupLocationsByUri(references);
  const lines = [`References: ${references.length} in ${groups.length} file(s)`];

  for (const [uri, items] of groups.slice(0, MAX_GROUPS)) {
    lines.push(`- ${locations.display(uri)} (${items.length})`);

    for (const item of items.slice(0, MAX_ITEMS_PER_GROUP)) {
      lines.push(`  - ${await locations.line(uri, item.range.start.line + 1)}`);
    }

    if (items.length > MAX_ITEMS_PER_GROUP) {
      lines.push(`  - ... ${items.length - MAX_ITEMS_PER_GROUP} more`);
    }
  }

  if (groups.length > MAX_GROUPS) {
    lines.push(`- ... ${groups.length - MAX_GROUPS} more file(s)`);
  }

  return lines;
}

/** A calls section for a direction the server does not implement, or undefined when it does. */
function unsupportedCalls(
  document: LspCodeDocument,
  relations: SymbolRelations,
  direction: LspCallDirection,
): string[] | undefined {
  if (!relations.calls.unsupported.includes(direction)) return undefined;
  const label = direction === "incoming" ? "Incoming calls" : "Outgoing calls";
  return [`${label}: not supported by ${document.client.serverId}`];
}

async function formatIncomingCalls(
  calls: readonly LspIncomingCall[],
  locations: LocationPresenter,
): Promise<string[]> {
  const lines = [`Incoming calls: ${calls.length}`];
  // Servers such as clangd answer callers from an index that is rebuilt after edits.
  if (calls.length === 0)
    lines.push("- none found; the server's index can miss callers added in the last seconds");

  for (const call of calls.slice(0, MAX_CALLS)) {
    const line = call.fromRanges[0]?.start.line ?? call.from.selectionRange.start.line;
    const anchor = await locations.line(call.from.uri, line + 1);
    lines.push(
      `- ${symbolKindName(call.from.kind)} ${call.from.name} — ${locations.display(call.from.uri)} ${anchor}`,
    );
  }

  if (calls.length > MAX_CALLS) {
    lines.push(`- ... ${calls.length - MAX_CALLS} more`);
  }

  return lines;
}

async function formatOutgoingCalls(
  calls: readonly LspOutgoingCall[],
  locations: LocationPresenter,
): Promise<string[]> {
  const lines = [`Outgoing calls: ${calls.length}`];

  for (const call of calls.slice(0, MAX_CALLS)) {
    const anchor = await locations.line(call.to.uri, call.to.selectionRange.start.line + 1);
    lines.push(
      `- ${symbolKindName(call.to.kind)} ${call.to.name} — ${locations.display(call.to.uri)} ${anchor}`,
    );
  }

  if (calls.length > MAX_CALLS) {
    lines.push(`- ... ${calls.length - MAX_CALLS} more`);
  }

  return lines;
}

async function formatFileGraphSymbol(
  document: LspCodeDocument,
  symbol: LspCodeSymbol,
  relations: SymbolRelations,
  locations: LocationPresenter,
): Promise<string[]> {
  const kind = symbolKindName(symbol.kind);
  const definitionAnchor = await locations.line(document.uri, symbol.selectionRange.start.line + 1);
  const referenceFiles = groupLocationsByUri(relations.references).map(
    ([uri, items]) => `${locations.display(uri)} (${items.length})`,
  );
  const incoming = relations.calls.incoming.map(
    (call) => `${call.from.name} (${locations.display(call.from.uri)})`,
  );
  const outgoing = relations.calls.outgoing.map(
    (call) => `${call.to.name} (${locations.display(call.to.uri)})`,
  );
  const lines = [
    `### ${kind} ${symbol.name}`,
    `Selector: ${formatSymbolSelector(symbol.selector)}`,
    `Definition: ${definitionAnchor}`,
    `Used by: ${summarize(referenceFiles)}`,
    ...(unsupportedCalls(document, relations, "incoming") ?? [
      `Incoming calls: ${summarize(incoming)}`,
    ]),
    ...(unsupportedCalls(document, relations, "outgoing") ?? [
      `Outgoing calls: ${summarize(outgoing)}`,
    ]),
  ];

  if (symbol.children.length > 0) {
    lines.push("Members:");

    for (const child of symbol.children) {
      const source = callsReference(document.displayPath, child.selector);
      lines.push(`- ${symbolKindName(child.kind)} ${child.name} — calls ${source}`);
    }
  }

  return lines;
}

/** The `lsp_search` `calls` value for a declaration, with the same encoding as symbol references. */
function callsReference(filePath: string, selector: readonly string[]): string {
  return formatCodeViewReference("graph", filePath, selector).slice("graph:".length);
}

function summarize(items: readonly string[], limit = 5): string {
  if (items.length === 0) {
    return "none";
  }

  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown}, ... ${items.length - limit} more` : shown;
}

function groupLocationsByUri(locations: readonly LspLocation[]): [string, LspLocation[]][] {
  const grouped = new Map<string, LspLocation[]>();

  for (const location of locations) {
    const current = grouped.get(location.uri) ?? [];
    current.push(location);
    grouped.set(location.uri, current);
  }

  return [...grouped]
    .map(
      ([uri, items]) =>
        [
          uri,
          items.sort(
            (left, right) =>
              left.range.start.line - right.range.start.line ||
              left.range.start.character - right.range.start.character,
          ),
        ] as [string, LspLocation[]],
    )
    .sort(([left], [right]) => left.localeCompare(right));
}

class LocationPresenter {
  readonly #cwd: string;

  public constructor(cwd: string) {
    this.#cwd = cwd;
  }

  public display(uri: string): string {
    return displayFilePath(filePathFromUri(uri), this.#cwd);
  }

  public line(_uri: string, lineNumber: number): Promise<string> {
    return Promise.resolve(String(lineNumber));
  }
}

function filePathFromUri(uri: string): string {
  if (!uri.startsWith("file://")) {
    return uri;
  }

  try {
    return fileURLToPath(uri);
  } catch {
    return decodeURIComponent(uri.slice("file://".length));
  }
}

function displayFilePath(filePath: string, cwd: string): string {
  if (filePath.startsWith("ssh://")) return filePath;
  const relative = path.relative(cwd, filePath);

  // oxlint-disable-next-line repo/no-parent-paths -- defensive check against traversal, not a traversal
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }

  return relative.replaceAll(path.sep, "/");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal, fallback?: unknown): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }

  if (fallback instanceof Error) {
    return fallback;
  }

  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Whether the server's ranges belong to this text: the symbol's name is where it says. A name
 * range over several lines cannot be checked this way and never matches.
 */
function answeredFor(text: string, symbol: LspCodeSymbol): boolean {
  const lines = text.split("\n");
  const { start, end } = symbol.selectionRange;
  if (start.line !== end.line) return false;
  return lines[start.line]?.slice(start.character, end.character) === symbol.name;
}
