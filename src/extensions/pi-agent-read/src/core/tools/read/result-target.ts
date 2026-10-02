import { readFile } from "node:fs/promises";
import type { ResultTargetStore } from "pi-agent-resource";
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
        const target = store.register(
          first === undefined || last === undefined
            ? []
            : [
                {
                  source: state.source,
                  expectedContent: content,
                  ranges: [
                    {
                      start: { lineNumber: first.lineNumber, column: 0 },
                      end:
                        last.lineEnding.length > 0
                          ? { lineNumber: last.lineNumber + 1, column: 0 }
                          : { lineNumber: last.lineNumber, column: last.content.length },
                      linewise: true,
                    },
                  ],
                },
              ],
          context.resolverContext.cwd,
        );
        return { ...result, script: { ...script, target } };
      },
    };
  };
}
