import type {
  ReadPipelineContext,
  ReadPreReadHandler,
  ReadPostReadHandler,
  ReadToolPluginApi,
} from "pi-agent-ide/api/read";
import { ResourceError, type ResultRange, type ResultTargetStore } from "pi-agent-ide/api/resource";
import { parseGithubAddress } from "./address.ts";
import type { GithubConnectionAccess, GithubConnectionBoundary } from "./connections/manager.ts";
import { githubLocation } from "./environment.ts";
import { assertGithubAccess, githubOperationSignal } from "./connections/boundary.ts";

/** Capture before acquisition, then keep that owner through asynchronous presentation. */
export function createGithubReadOwnership(boundary?: GithubConnectionBoundary) {
  const owners = new WeakMap<ReadPipelineContext["resolverContext"], GithubConnectionAccess>();
  const preRead: ReadPreReadHandler = async (context) => {
    if (!boundary || !githubLocation(context.request.path)?.resource)
      return { kind: "continue", context };
    const access = await boundary.capture(
      context.resolverContext.cwd,
      context.resolverContext.signal,
    );
    const resolverContext = {
      ...context.resolverContext,
      signal: githubOperationSignal(access, context.resolverContext.signal),
    };
    owners.set(resolverContext, access);
    return { kind: "continue", context: { ...context, resolverContext } };
  };
  return {
    preRead,
    access(context: ReadPipelineContext): GithubConnectionAccess | undefined {
      if (!boundary) return undefined;
      const access = owners.get(context.resolverContext);
      const source = context.state?.source ?? context.request.path ?? "github:";
      if (!access) throw new ResourceError("GH_CONNECTION_CHANGED", source, "not-applied");
      assertGithubAccess(access, source);
      return access;
    },
  };
}
/** Retain an exact text window with a guarded owning reread. An ownership predicate enables trusted readonly generated views; editable bodies still require original source text. */
export function createGithubBodySelectionHandler(
  store: ResultTargetStore,
  read: ReadToolPluginApi["read"],
  resolverId: string,
  owns?: (source: string) => boolean,
  ownership?: ReturnType<typeof createGithubReadOwnership>,
): ReadPostReadHandler {
  return async (context) => {
    const state = context.state;
    if (
      state?.contentKind !== "text" ||
      state.resolvedBy !== resolverId ||
      (owns === undefined && context.sourceText !== state.text.content)
    )
      return { kind: "continue", context };
    const address = owns ? undefined : parseGithubAddress(state.source);
    if (
      owns ? !owns(state.source) : !address?.facet || ["schema", "actions"].includes(address.facet)
    )
      return { kind: "continue", context };
    const cwd = context.resolverContext.cwd;
    const access = ownership?.access(context);
    const input =
      context.sourceTarget === undefined ? undefined : store.resolve(context.sourceTarget, cwd);
    const retained = input?.targets.filter((target) => target.source === state.source);
    if (retained?.some((target) => target.expectedContent !== state.text.content))
      return { kind: "continue", context };
    return {
      kind: "continue",
      context,
      transform(result) {
        assertGithubAccess(access, state.source);
        const script = result.script;
        if (result.isError || script?.kind !== "text" || script.source !== state.source)
          return result;
        if (
          !script.lines.every((line, index) => {
            if (line.lineNumber < 1) return false;
            const original = state.text.lines.at(line.lineNumber - 1);
            return (
              original !== undefined &&
              original.content === line.content &&
              original.lineEnding === line.lineEnding &&
              (index === 0 || line.lineNumber === script.lines[index - 1].lineNumber + 1)
            );
          })
        )
          return result;
        const first = script.lines.at(0);
        const last = script.lines.at(-1);
        const window: ResultRange | undefined =
          first && last
            ? {
                start: { lineNumber: first.lineNumber, column: 0 },
                end:
                  last.lineEnding.length > 0
                    ? { lineNumber: last.lineNumber + 1, column: 0 }
                    : { lineNumber: last.lineNumber, column: last.content.length },
                linewise: true,
              }
            : state.text.content.length === 0
              ? { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 0 } }
              : undefined;
        if (!window) return result;
        const ranges =
          retained === undefined
            ? [window]
            : retained.flatMap((target) =>
                target.ranges.flatMap((range) => intersect(range, window)),
              );
        const target = store.register(
          [
            {
              source: state.source,
              expectedContent: state.text.content,
              ranges,
              async readCurrent(signal) {
                assertGithubAccess(access, state.source);
                const current = await read(
                  { path: state.source },
                  { cwd, signal: githubOperationSignal(access, signal) },
                  "script",
                );
                assertGithubAccess(access, state.source);
                if (
                  current.isError ||
                  current.script?.kind !== "text" ||
                  current.script.source !== state.source
                )
                  throw new Error("GH_SNAPSHOT_UNVERIFIED");
                return current.script.content;
              },
            },
          ],
          cwd,
          input?.complete ?? true,
        );
        return { ...result, script: { ...script, target } };
      },
    };
  };
}

function intersect(seed: ResultRange, window: ResultRange): ResultRange[] {
  const compare = (a: ResultRange["start"], b: ResultRange["start"]) =>
    a.lineNumber - b.lineNumber || a.column - b.column;
  const start = compare(seed.start, window.start) >= 0 ? seed.start : window.start;
  const end = compare(seed.end, window.end) <= 0 ? seed.end : window.end;
  return compare(start, end) > 0 ||
    (compare(start, end) === 0 && compare(seed.start, seed.end) !== 0)
    ? []
    : [{ start, end }];
}
