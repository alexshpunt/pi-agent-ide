import { readFile } from "node:fs/promises";
import type { ResultRange, ResultTargetStore } from "pi-agent-resource";
import type { ReadPostReadHandler, ReadToolPluginApi } from "#src/api/tools/read.js";

/** Retain exact local or SSH text windows with an owning, guarded reread; never grant authority to converted output. */
export function createReadResultTargetHandler(
  store: ResultTargetStore,
  read: ReadToolPluginApi["read"],
): ReadPostReadHandler {
  return async (context) => {
    const state = context.state;
    if (
      state?.contentKind !== "text" ||
      !["filesystem", "ssh"].includes(state.resolvedBy) ||
      context.sourceText !== state.text.content
    )
      return { kind: "continue", context };
    if (state.resolvedBy === "filesystem") {
      try {
        const current = await readFile(state.source, {
          encoding: "utf8",
          signal: context.resolverContext.signal,
        });
        if (current !== state.text.content) return { kind: "continue", context };
      } catch {
        context.resolverContext.signal?.throwIfAborted();
        return { kind: "continue", context };
      }
    }
    const input =
      context.sourceTarget === undefined
        ? undefined
        : store.resolve(context.sourceTarget, context.resolverContext.cwd);
    const retained = input?.targets.filter((target) => target.source === state.source);
    if (retained?.some((target) => target.expectedContent !== state.text.content))
      return { kind: "continue", context };
    return {
      kind: "continue",
      context,
      transform(result) {
        const script = result.script;
        if (result.isError || script?.kind !== "text" || script.source !== state.source)
          return result;
        if (
          !script.lines.every((line) => {
            const original = state.text.lines[line.lineNumber - 1];
            return original?.content === line.content && original.lineEnding === line.lineEnding;
          })
        )
          return result;
        const first = script.lines[0];
        const last = script.lines.at(-1);
        const range: ResultRange | undefined =
          first === undefined || last === undefined
            ? state.text.content.length === 0
              ? { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 0 } }
              : undefined
            : {
                start: { lineNumber: first.lineNumber, column: 0 },
                end:
                  last.lineEnding.length > 0
                    ? { lineNumber: last.lineNumber + 1, column: 0 }
                    : { lineNumber: last.lineNumber, column: last.content.length },
                linewise: true,
              };
        const target = store.register(
          range === undefined
            ? []
            : [
                {
                  source: state.source,
                  expectedContent: state.text.content,
                  ranges:
                    retained === undefined
                      ? [range]
                      : retained.flatMap((target) =>
                          target.ranges.flatMap((seed) => intersectRange(seed, range)),
                        ),
                  async readCurrent(signal) {
                    const current = await read(
                      { path: state.source },
                      {
                        cwd: context.resolverContext.cwd,
                        ...(signal === undefined ? {} : { signal }),
                      },
                      "script",
                    );
                    if (
                      current.isError ||
                      current.script?.kind !== "text" ||
                      current.script.source !== state.source
                    )
                      throw new Error("Could not verify the owning source; repeat Read/Search.");
                    return current.script.content;
                  },
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

function intersectRange(seed: ResultRange, window: ResultRange): ResultRange[] {
  const compare = (a: ResultRange["start"], b: ResultRange["start"]) =>
    a.lineNumber - b.lineNumber || a.column - b.column;
  const start = compare(seed.start, window.start) >= 0 ? seed.start : window.start;
  const end = compare(seed.end, window.end) <= 0 ? seed.end : window.end;
  return compare(start, end) > 0 ||
    (compare(start, end) === 0 && compare(seed.start, seed.end) !== 0)
    ? []
    : [{ start, end }];
}
