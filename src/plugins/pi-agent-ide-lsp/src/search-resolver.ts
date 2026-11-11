import { ResultPanel } from "pi-agent-tool-ui";
import {
  formatSymbolSelector,
  parseCodeViewReference,
  resolveCodeViewPath,
} from "pi-agent-ide/api/code-view";
import { verifyResultTargets, type ResolvedResultTargets } from "pi-agent-resource";
import {
  currentScope,
  renderSearchMatches,
  selectionData,
  type SearchPluginApi,
  type SearchRequest,
  type SearchResolver,
  type SearchSelectionMatch,
} from "pi-agent-search/api/search";
import path from "node:path";
import { readLspFileGraph, readLspSymbolGraph, resolveLspDeclaration } from "./lsp/code-views.ts";
import { coverageNotes, mergeCoverage, type ClangCoverage } from "./lsp/clang-coverage.ts";
import type { LspManager } from "./lsp/manager.ts";
import { searchSymbols, type SymbolHit } from "./lsp/symbol-search.ts";
import { withLspDocuments } from "./lsp/document-leases.ts";
import { retryWhileSourceChanges, sourceChanged } from "./lsp/source-changes.ts";

/** Options the `lsp_search` tool passes in `SearchRequest.options.lsp`; their presence selects this resolver. */
export interface LspSearchOptions {
  /** Workspace symbol names to find. */
  readonly query?: string;
  /** Follow symbols found inside the path scope to references outside it. */
  readonly references?: boolean;
  /** `file#selector`: the exact declaration as an editable selection. */
  readonly declaration?: string;
  /** `file` or `file#selector`: incoming and outgoing calls and references. */
  readonly calls?: string;
}

type ManagerFor = (cwd: string, source?: string, signal?: AbortSignal) => Promise<LspManager>;

type Payload =
  | {
      readonly mode: "symbols";
      readonly sessionId: string;
      readonly hits: readonly SymbolHit[];
      readonly complete: boolean;
      /** Why C/C++ references can be missing. */
      readonly coverage?: ClangCoverage;
      readonly references: boolean;
      readonly data: unknown;
    }
  | {
      readonly mode: "declaration";
      readonly sessionId: string;
      readonly selector: string;
      readonly match: SearchSelectionMatch;
      readonly data: unknown;
    }
  | { readonly mode: "calls"; readonly text: string };

function lspOptions(request: SearchRequest): LspSearchOptions | undefined {
  const value = request.options?.lsp;
  return typeof value === "object" && value !== null ? value : undefined;
}

/** Language-server queries the resolver runs; tests can supply faithful implementations. */
export interface LspSearchBackend {
  readonly resolveLspDeclaration: typeof resolveLspDeclaration;
  readonly readLspFileGraph: typeof readLspFileGraph;
  readonly readLspSymbolGraph: typeof readLspSymbolGraph;
  readonly searchSymbols: typeof searchSymbols;
}

const defaultBackend: LspSearchBackend = {
  resolveLspDeclaration,
  readLspFileGraph,
  readLspSymbolGraph,
  searchSymbols,
};

/** Language-server discovery, declarations and call graphs as shared source targets. */
export function createLspSearchResolver(
  managerFor: ManagerFor,
  registerSelection: SearchPluginApi["registerSelection"],
  backend: LspSearchBackend = defaultBackend,
): SearchResolver {
  return {
    id: "lsp",
    supportsResultScope: true,
    // Workspace symbol backends may read beyond the requested path.
    readResources: (request) => (lspOptions(request) === undefined ? [] : undefined),
    toScriptData(payload) {
      const result = payload as Payload;
      return result.mode === "calls"
        ? { kind: "custom", resolverId: "lsp", value: { calls: result.text } }
        : result.data;
    },
    tryResolve(request, context) {
      // Anchors register only while the file still has the text the server answered for; another
      // process may write it in between, and the search then runs again on the new text.
      const register = async (selection: Parameters<typeof registerSelection>[0]) => {
        try {
          return await registerSelection(selection, context);
        } catch (error) {
          if (error instanceof Error && error.name === "SearchSnapshotChangedError")
            throw sourceChanged(error.message);
          throw error;
        }
      };
      // Documents opened for this request close when it finishes.
      return withLspDocuments(async () => {
        const options = lspOptions(request);
        if (options === undefined) return { kind: "not-handled" };
        const modes = [options.query, options.declaration, options.calls].filter(
          (value) => value !== undefined,
        );
        if (modes.length !== 1)
          return {
            kind: "failed",
            error: new Error("Pass exactly one of query, declaration or calls."),
          };

        if (options.calls !== undefined) {
          const reference = parseCodeViewReference(`graph:${options.calls}`, "graph");
          if (reference === undefined) throw new Error("calls requires a file path.");
          const filePath = resolveCodeViewPath(reference.path, context.cwd);
          const manager = await managerFor(context.cwd, filePath, context.signal);
          const text =
            reference.selector === undefined
              ? await backend.readLspFileGraph(manager, filePath, context.cwd, context.signal)
              : await backend.readLspSymbolGraph(
                  manager,
                  filePath,
                  reference.selector,
                  context.cwd,
                  context.signal,
                );
          return { kind: "resolved", payload: { mode: "calls", text } satisfies Payload };
        }

        if (options.declaration !== undefined) {
          const reference = options.declaration.includes("#")
            ? parseCodeViewReference(`symbol:${options.declaration}`, "symbol")
            : undefined;
          if (reference?.selector === undefined)
            throw new Error("declaration requires file#selector, such as src/app.ts#App/start.");
          const filePath = resolveCodeViewPath(reference.path, context.cwd);
          const selector = reference.selector;
          const resolve = async (signal?: AbortSignal) => {
            const manager = await managerFor(context.cwd, filePath, signal);
            const found = await backend.resolveLspDeclaration(
              manager,
              filePath,
              selector,
              context.cwd,
              signal,
            );
            // Keep only the declaration text, not the whole file it was cut from.
            return structuredClone(declarationMatch(found.source, found.content, found.range));
          };
          const { match, session } = await retryWhileSourceChanges(async () => {
            const match = await resolve(context.signal);
            const session = await register({
              request,
              matches: [match],
              complete: true,
              refresh: (signal) =>
                withLspDocuments(async () => ({
                  matches: [await resolve(signal)],
                  complete: true,
                })),
            });
            return { match, session };
          }, context.signal);
          return {
            kind: "resolved",
            payload: {
              mode: "declaration",
              sessionId: session.id,
              selector: options.declaration,
              match,
              data: selectionData([match], true, session.id, session),
            } satisfies Payload,
          };
        }

        const query = (options.query ?? "").trim();
        if (query.length === 0)
          return { kind: "failed", error: new Error("query must not be empty") };
        const references = options.references === true;
        const initialScope = context.scope;
        const groupScope = async (
          scope: ResolvedResultTargets | undefined,
          signal?: AbortSignal,
        ) => {
          const groups = new Map<LspManager, ResolvedResultTargets["targets"][number][]>();
          if (scope === undefined) {
            groups.set(await managerFor(context.cwd, request.path, signal), []);
            return groups;
          }
          for (const target of scope.targets) {
            const manager = await managerFor(context.cwd, target.source, signal);
            const group = groups.get(manager) ?? [];
            group.push(target);
            groups.set(manager, group);
          }
          return groups;
        };
        if (initialScope !== undefined) await verifyResultTargets(initialScope, context.signal);
        const initialGroups = await groupScope(initialScope, context.signal);
        const limit = request.limit ?? 100;
        // A refresh, such as for an all-anchor after other edits, finds the scope in the current
        // text first, like text and AST search; the scope as first resolved is stale by then.
        const collect = async (signal?: AbortSignal, refresh = false) => {
          const scope = refresh ? await currentScope(context, signal) : initialScope;
          const groups = refresh ? await groupScope(scope, signal) : initialGroups;
          const hits: SymbolHit[] = [];
          let complete = scope?.complete ?? true;
          const coverages: (ClangCoverage | undefined)[] = [];
          for (const [manager, targets] of groups) {
            const found = await backend.searchSymbols(
              query,
              manager.workspaceRoot,
              limit,
              signal,
              {
                ...(request.path === undefined ? {} : { path: request.path }),
                ...(request.include === undefined ? {} : { include: request.include }),
                ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
                ...(references ? { navigation: "references" as const } : {}),
                ...(scope === undefined
                  ? {}
                  : { resultScope: { targets, complete: scope.complete } }),
              },
              manager,
            );
            hits.push(...found.hits);
            complete = complete && found.complete;
            coverages.push(found.coverage);
          }
          if (scope !== undefined) {
            try {
              await verifyResultTargets(scope, signal);
            } catch (error) {
              // During a refresh the scope was current a moment ago: another writer changed the
              // file meanwhile, which an edit retries on the new text.
              if (!refresh || signal?.aborted === true) throw error;
              throw Object.assign(
                new Error("The file changed while the LSP search ran again.", { cause: error }),
                { code: "SOURCE_CHANGED" },
              );
            }
          }
          // The search session keeps these hits and its refresh closure for as long as its anchors
          // live. A copy keeps only the matched text, not each file the text was cut from.
          const coverage = mergeCoverage(coverages);
          return structuredClone({
            hits: hits.slice(0, limit),
            complete: complete && hits.length <= limit,
            ...(coverage && { coverage }),
          });
        };
        let attempts = 0;
        const { found, session } = await retryWhileSourceChanges(async () => {
          // A later attempt finds the scope in the current text, like a refresh.
          const found = await collect(context.signal, attempts++ > 0);
          const session = await register({
            request,
            matches: found.hits,
            complete: found.complete,
            refresh: (signal) =>
              withLspDocuments(async () => {
                const next = await collect(signal, true);
                return { matches: next.hits, complete: next.complete };
              }),
          });
          return { found, session };
        }, context.signal);
        const data = selectionData(found.hits, found.complete, session.id, session);
        return {
          kind: "resolved",
          payload: {
            mode: "symbols",
            sessionId: session.id,
            hits: found.hits,
            complete: found.complete,
            ...(found.coverage && { coverage: found.coverage }),
            references,
            data: {
              ...data,
              matches: data.matches.map((match, index) => ({
                ...match,
                role: found.hits[index]?.role,
                symbol: found.hits[index]?.symbol,
              })),
            },
          } satisfies Payload,
        };
      });
    },
    renderResult(result, options, theme) {
      const data = result.details as Payload & { cwd: string };
      if (data.mode === "calls")
        return new ResultPanel(
          {
            summary: data.text.split("\n", 1)[0] ?? "Calls",
            rows: data.text
              .split("\n")
              .slice(1)
              .map((text) => ({ kind: "note" as const, text })),
          },
          theme,
          options.expanded,
        );
      if (data.mode === "declaration")
        return renderSearchMatches(
          [data.match],
          true,
          theme,
          options.expanded,
          data.cwd,
          [],
          [data.selector],
        );
      return renderSearchMatches(
        data.hits,
        data.complete,
        theme,
        options.expanded,
        data.cwd,
        [
          ...(data.references ? ["LSP reference navigation · may leave input scope"] : []),
          ...coverageNotes(data.coverage, (source) => displaySource(source, data.cwd)),
        ],
        data.hits.map((hit) => `${hit.role} ${hit.symbol.name}`),
      );
    },
    format(payload, context) {
      const result = payload as Payload;
      const display = (source: string) => displaySource(source, context.cwd);
      if (result.mode === "calls")
        return { content: [{ type: "text", text: result.text }], details: result };
      if (result.mode === "declaration") {
        const { match } = result;
        // A selection ending at column 0 of the next line ends on the line before it.
        const end = match.endLineNumber ?? match.lineNumber;
        const lastLine = end > match.lineNumber && match.endColumn === 0 ? end - 1 : end;
        return {
          content: [
            {
              type: "text",
              text: [
                `SEARCH#${result.sessionId}:1:match ${display(match.source)}:${match.lineNumber}-${lastLine} declaration ${result.selector}`,
                match.matchedText.replace(/\r?\n$/u, ""),
              ].join("\n"),
            },
          ],
          details: { ...result, cwd: context.cwd },
        };
      }
      const heading = result.references
        ? "LSP reference navigation (may leave input scope)"
        : "LSP symbols inside scope";
      const lines =
        result.hits.length === 0
          ? ["No symbols found."]
          : result.hits.slice(0, 100).map(
              (hit, index) =>
                `SEARCH#${result.sessionId}:${index + 1}:match ${display(hit.source)}:${hit.lineNumber}:${hit.startColumn + 1} ${hit.role} ${hit.symbol.name} · ${
                  // A definition names the selector of its declaration, which tells overloads apart.
                  hit.role === "definition" && hit.symbol.selector !== undefined
                    ? `selector ${display(hit.symbol.source)}#${formatSymbolSelector(hit.symbol.selector)}`
                    : `declared at ${display(hit.symbol.source)}:${hit.symbol.range.startLine}:${hit.symbol.range.startColumn + 1}`
                }`,
            );
      if (result.complete && result.hits.length)
        lines.unshift(`SEARCH#${result.sessionId}:all:match selects all exact symbol matches.`);
      if (result.hits.length > 100) lines.push("Preview shortened; full source targets retained.");
      lines.push(...coverageNotes(result.coverage, display));
      return {
        content: [{ type: "text", text: [heading, ...lines].join("\n") }],
        details: { ...result, cwd: context.cwd },
      };
    },
  };
}

/** A source as the result names it: relative to the workspace, or its ssh:// URI. */
function displaySource(source: string, cwd: string): string {
  return source.startsWith("ssh://") ? source : path.relative(cwd, source);
}

/**
 * Select the complete lines of an LSP range (zero-based lines), including the final line ending,
 * so deleting or moving a declaration does not leave an empty line behind.
 */
function declarationMatch(
  source: string,
  content: string,
  range: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  },
): SearchSelectionMatch {
  const raw = content.split("\n");
  const lines = raw.map((line) => line.replace(/\r$/u, ""));
  const starts = [0];
  for (const line of raw) starts.push((starts.at(-1) ?? 0) + line.length + 1);
  const first = range.start.line;
  const hasNextLine = range.end.line + 1 < raw.length;
  // Without a following line, the selection ends at the end of the last declaration line.
  const endLine = hasNextLine ? range.end.line + 1 : range.end.line;
  const endColumn = hasNextLine ? 0 : (lines[range.end.line] ?? "").length;
  const from = starts[first] ?? content.length;
  const to = Math.min(content.length, (starts[endLine] ?? content.length) + endColumn);
  return {
    source,
    lineNumber: first + 1,
    startColumn: 0,
    ...(endLine === first ? {} : { endLineNumber: endLine + 1 }),
    endColumn,
    matchedText: content.slice(from, to),
    lineText: lines[first] ?? "",
  };
}
