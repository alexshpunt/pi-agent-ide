/* oxlint-disable import/no-absolute-path -- Load only the current develop IDE, never this worktree as a second IDE source. */
import {
  connectReadPlugin,
  READ_PROTOCOL,
  READ_API_VERSION,
  type ReadPostReadHandler,
} from "/root/dev/pi/pi-agent-ide/src/api/read.ts";
import {
  connectResultTargets,
  type ResultRange,
  type ResultTargetStore,
  type ResultSourceTarget,
  type ResourceResolverContext,
  type ResourceOperationContext,
} from "/root/dev/pi/pi-agent-ide/src/api/resource.ts";
import {
  connectSearchPlugin,
  SEARCH_PROTOCOL,
  SEARCH_API_VERSION,
  selectionData,
  containsSearchMatch,
  type SearchContext,
  type SearchRequest,
  type SearchSelectionMatch,
} from "/root/dev/pi/pi-agent-ide/src/api/search.ts";
import { ReaOwner } from "./owner.mjs";
import { literalMatches } from "./matches.mjs";
import { connectRea } from "./connection.mjs";

type ExtensionAPI = Parameters<typeof connectReadPlugin>[0];
type ResearchConfig = Parameters<typeof connectRea>[0] & { binary: string; application: string };
const resolverId = "rea-research";
const owns = (source: string) => source.startsWith("rea://");
const compare = (a: ResultRange["start"], b: ResultRange["start"]) =>
  a.lineNumber - b.lineNumber || a.column - b.column;

function targetHandler(owner: ReaOwner, targets: ResultTargetStore): ReadPostReadHandler {
  return async (context) => {
    const state = context.state;
    if (state?.contentKind !== "text" || state.resolvedBy !== resolverId)
      return { kind: "continue", context };
    if ((await owner.read(state.source, context.resolverContext.signal)) !== state.text.content)
      return { kind: "continue", context };
    const input = context.sourceTarget
      ? targets.resolve(context.sourceTarget, context.resolverContext.cwd)
      : undefined;
    return {
      kind: "continue",
      context,
      transform(result) {
        const script = result.script;
        if (result.isError || script?.kind !== "text" || script.source !== state.source)
          return result;
        const first = script.lines[0];
        const last = script.lines.at(-1);
        if (
          !first ||
          !last ||
          !script.lines.every((line) => {
            const original = state.text.lines[line.lineNumber - 1];
            return original?.content === line.content && original.lineEnding === line.lineEnding;
          })
        )
          return result;
        const window: ResultRange = {
          start: { lineNumber: first.lineNumber, column: 0 },
          end: last.lineEnding.length
            ? { lineNumber: last.lineNumber + 1, column: 0 }
            : { lineNumber: last.lineNumber, column: last.content.length },
          linewise: true,
        };
        const ranges = input
          ? input.targets
              .filter((target) => target.source === state.source)
              .flatMap((target) =>
                target.ranges.flatMap((seed) => {
                  const start = compare(seed.start, window.start) >= 0 ? seed.start : window.start;
                  const end = compare(seed.end, window.end) <= 0 ? seed.end : window.end;
                  return compare(start, end) < 0 ? [{ start, end }] : [];
                }),
              )
          : [window];
        const target = targets.register(
          [
            {
              source: state.source,
              expectedContent: state.text.content,
              ranges,
              readCurrent: (signal) => owner.read(state.source, signal),
            },
          ],
          context.resolverContext.cwd,
          input?.complete ?? true,
        );
        return { ...result, script: { ...script, target } };
      },
    };
  };
}

async function findMatches(owner: ReaOwner, request: SearchRequest, context: SearchContext) {
  if (
    !request.query ||
    /[\r\n]/.test(request.query) ||
    /^(?:regex|ast|symbols|files|process):/i.test(request.query)
  )
    throw new Error(
      "REA research Search accepts one literal text query, not regex, AST or symbol protocols",
    );
  if (request.include || request.exclude || request.navigation)
    throw new Error("REA research Search does not support file filters or navigation");
  const sources = context.scope
    ? [...new Set(context.scope.targets.map((target: ResultSourceTarget) => target.source))]
    : request.path
      ? [request.path]
      : [];
  const matches: SearchSelectionMatch[] = [];
  const maximum = request.limit ?? 50;
  for (const source of sources) {
    const snapshot = await owner.resolve(source, context.signal);
    const text = await owner.read(snapshot.source, context.signal);
    for (const hit of literalMatches(text, request.query, request)) {
      context.signal?.throwIfAborted();
      const match = { source: snapshot.source, ...hit };
      if (context.scope && !containsSearchMatch(context.scope, match)) continue;
      matches.push(match);
      if (matches.length > maximum) return { matches: matches.slice(0, maximum), complete: false };
    }
  }
  return { matches, complete: true };
}

/** Opt-in Linux/WSL research addon. The bootstrap supplies exact owned inputs and pinned portable engines. */
export async function installRea(pi: ExtensionAPI, config: ResearchConfig) {
  const targets = connectResultTargets(pi);
  let owner = new ReaOwner(config, (signal?: AbortSignal) => connectRea(config, signal));
  pi.on("session_start", async () => {
    await owner.close();
    owner = new ReaOwner(config, (signal?: AbortSignal) => connectRea(config, signal));
  });
  pi.on("session_shutdown", async () => {
    await owner.close();
  });
  pi.registerCommand("rea-research-close", {
    description: "Close the private REA research session and expire its resource references",
    handler: async (_args, context) => {
      await owner.close();
      context.ui.notify("REA research session closed; its resource references expired", "info");
    },
  });
  await Promise.all([
    connectReadPlugin(pi, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: resolverId,
      setup(api) {
        api.describe({
          path: "rea://native/<function> reads configured Ghidra pseudocode; rea://application/summary reads configured static JS/ASAR Evidence. Returned rea://<session>/<evidence>/<facet> URIs are immutable, read-only and expire when this private research session closes. Requires an explicit local research bootstrap; not enabled by default.",
        });
        api.addResolver({
          resolver: {
            id: resolverId,
            async tryResolve(source: string, context: ResourceResolverContext) {
              if (!owns(source)) return { kind: "not-handled" };
              const snapshot = await owner.resolve(source, context.signal);
              return {
                kind: "resolved",
                resource: {
                  source: snapshot.source,
                  read: async ({ signal }: ResourceOperationContext) => [
                    { type: "text", text: await owner.read(snapshot.source, signal) },
                  ],
                },
              };
            },
          },
        });
        api.addHandler({
          stage: "post-read",
          handler: (context) => targetHandler(owner, targets)(context),
        });
      },
    }),
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: resolverId,
      setup(api) {
        api.describe(
          "For rea:// sources and their unchanged results, Search accepts literal text, caseSensitive, wholeWord and limit only. Matches are static snapshot text, not native symbol resolution; use text Select, not JS/TS structural operations.",
        );
        api.addResolver({
          priority: -20,
          resolver: {
            id: resolverId,
            supportsResultScope: true,
            readResources: (request, context) =>
              context.scope
                ? context.scope.targets.map((target: ResultSourceTarget) => target.source)
                : request.path && owns(request.path)
                  ? [request.path]
                  : [],
            async tryResolve(request, context) {
              const sources =
                context.scope?.targets.map((target: ResultSourceTarget) => target.source) ??
                (request.path ? [request.path] : []);
              if (!sources.some(owns)) return { kind: "not-handled" };
              if (!sources.every(owns))
                throw new Error("REA research Search cannot mix source owners");
              const found = await findMatches(owner, request, context);
              const selection = await api.registerSelection(
                {
                  ...found,
                  request,
                  refresh: (signal) => findMatches(owner, request, { ...context, signal }),
                },
                context,
              );
              return { kind: "resolved", payload: { ...found, selection } };
            },
            toScriptData(payload) {
              const data = payload as {
                matches: SearchSelectionMatch[];
                complete: boolean;
                selection: { id: string; target?: string; matchTargets?: readonly string[] };
              };
              return selectionData(data.matches, data.complete, data.selection.id, data.selection);
            },
            format(payload) {
              const data = payload as {
                matches: SearchSelectionMatch[];
                complete: boolean;
                selection: { target?: string };
              };
              return {
                content: [
                  {
                    type: "text",
                    text: `${data.matches.length} REA static text matches; complete=${data.complete}\n${data.selection.target ?? ""}\n${data.matches.map((match) => `${match.source}:${match.lineNumber}:${match.startColumn} ${match.lineText}`).join("\n")}`,
                  },
                ],
                details: data,
              };
            },
          },
        });
      },
    }),
  ]);
}
