import { readFile } from "node:fs/promises";
import type { ResultRange, ResultTargetStore } from "pi-agent-resource";
import type { ReadPostReadHandler } from "#src/api/tools/read.js";

/** Attach source authority only when the read still maps to exact filesystem text. */
export function createReadResultTargetHandler(store: ResultTargetStore): ReadPostReadHandler {
  return async (context) => {
    const state = context.state;
    if (state?.contentKind !== "text" || state.resolvedBy !== "filesystem")
      return { kind: "continue", context };
    let content: string;
    try {
      content = await readFile(state.source, {
        encoding: "utf8",
        signal: context.resolverContext.signal,
      });
    } catch {
      context.resolverContext.signal?.throwIfAborted();
      return { kind: "continue", context };
    }
    if (content !== state.text.content) return { kind: "continue", context };
    const input =
      context.sourceTarget === undefined
        ? undefined
        : store.resolve(context.sourceTarget, context.resolverContext.cwd);
    const sources = input?.targets.filter((target) => target.source === state.source);
    if (sources?.some((target) => target.expectedContent !== content))
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
        const window: ResultRange | undefined =
          first === undefined || last === undefined
            ? content.length === 0
              ? {
                  start: { lineNumber: 1, column: 0 },
                  end: { lineNumber: 1, column: 0 },
                }
              : undefined
            : {
                start: { lineNumber: first.lineNumber, column: 0 },
                end:
                  last.lineEnding.length > 0
                    ? { lineNumber: last.lineNumber + 1, column: 0 }
                    : { lineNumber: last.lineNumber, column: last.content.length },
                linewise: true,
              };
        const ranges =
          window === undefined
            ? []
            : sources === undefined
              ? [window]
              : sources.flatMap((source) =>
                  source.ranges.flatMap((range) => intersectRange(range, window)),
                );
        const target = store.register(
          ranges.length === 0 ? [] : [{ source: state.source, expectedContent: content, ranges }],
          context.resolverContext.cwd,
          input?.complete ?? true,
        );
        return { ...result, script: { ...script, target } };
      },
    };
  };
}

function comparePosition(left: ResultRange["start"], right: ResultRange["start"]): number {
  return left.lineNumber - right.lineNumber || left.column - right.column;
}

function intersectRange(range: ResultRange, window: ResultRange): ResultRange[] {
  const start = comparePosition(range.start, window.start) >= 0 ? range.start : window.start;
  const end = comparePosition(range.end, window.end) <= 0 ? range.end : window.end;
  if (
    comparePosition(start, end) > 0 ||
    (comparePosition(start, end) === 0 && comparePosition(range.start, range.end) !== 0)
  )
    return [];
  return [{ start, end }];
}
