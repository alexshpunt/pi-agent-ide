import { ResultPanel } from "pi-agent-tool-ui";
import { parseCodeViewReference, resolveCodeViewPath } from "pi-agent-ide/api/code-view";
import { verifyResultTargets, type ResolvedResultTargets } from "pi-agent-resource";
import {
  renderSearchMatches,
  selectionData,
  type SearchPluginApi,
  type SearchRequest,
  type SearchResolver,
  type SearchSelectionMatch,
} from "pi-agent-search/api/search";
import path from "node:path";
import { readLspFileGraph, readLspSymbolGraph, resolveLspDeclaration } from "./lsp/code-views.js";
import type { LspManager } from "./lsp/manager.js";
import { searchSymbols, type SymbolHit } from "./lsp/symbol-search.js";

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
    async tryResolve(request, context) {
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
          return declarationMatch(found.source, found.content, found.range);
        };
        const match = await resolve(context.signal);
        const session = await registerSelection(
          {
            request,
            matches: [match],
            complete: true,
            refresh: async (signal) => ({ matches: [await resolve(signal)], complete: true }),
          },
          context,
        );
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
          mode: "symbols",
          sessionId: session.id,
          hits: found.hits,
          complete: found.complete,
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
        data.references ? ["LSP reference navigation · may leave input scope"] : [],
        data.hits.map((hit) => `${hit.role} ${hit.symbol.name}`),
      );
    },
    format(payload, context) {
      const result = payload as Payload;
      const display = (source: string) =>
        source.startsWith("ssh://") ? source : path.relative(context.cwd, source);
      if (result.mode === "calls")
        return { content: [{ type: "text", text: result.text }], details: result };
      if (result.mode === "declaration") {
        const { match } = result;
        return {
          content: [
            {
              type: "text",
              text: [
                `SEARCH#${result.sessionId}:1:match ${display(match.source)}:${match.lineNumber}-${match.endLineNumber ?? match.lineNumber} declaration ${result.selector}`,
                match.matchedText,
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
          : result.hits
              .slice(0, 100)
              .map(
                (hit, index) =>
                  `SEARCH#${result.sessionId}:${index + 1}:match ${display(hit.source)}:${hit.lineNumber}:${hit.startColumn + 1} ${hit.role} ${hit.symbol.name} · declared at ${display(hit.symbol.source)}:${hit.symbol.range.startLine}:${hit.symbol.range.startColumn + 1}`,
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

/** Map an LSP range (zero-based lines, UTF-16 columns) onto a Search selection. */
function declarationMatch(
  source: string,
  content: string,
  range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  },
): SearchSelectionMatch {
  const lines = content.split("\n").map((line) => line.replace(/\r$/u, ""));
  const starts = [0];
  for (const line of content.split("\n")) starts.push((starts.at(-1) ?? 0) + line.length + 1);
  const from = (starts[range.start.line] ?? content.length) + range.start.character;
  const to = (starts[range.end.line] ?? content.length) + range.end.character;
  return {
    source,
    lineNumber: range.start.line + 1,
    startColumn: range.start.character,
    ...(range.end.line === range.start.line ? {} : { endLineNumber: range.end.line + 1 }),
    endColumn: range.end.character,
    matchedText: content.slice(from, to),
    lineText: lines[range.start.line] ?? "",
  };
}
