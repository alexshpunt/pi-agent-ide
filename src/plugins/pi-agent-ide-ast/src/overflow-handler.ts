import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { ReadPostReadHandler } from "pi-agent-read/api/tools/read";
import type { SourceViewBlock } from "pi-agent-ide/api/code-view";

/** Replace an overflowing file window with a source-numbered whole-file outline.
 * Small windows and files without a usable outline keep the normal read result.
 */
export function createAstOverflowHandler(): ReadPostReadHandler {
  return async (context) => {
    const { state, result } = context;
    const block = result?.content.length === 1 ? result.content[0] : undefined;
    if (
      state?.contentKind !== "text" ||
      state.resolvedBy !== "filesystem" ||
      block?.type !== "text" ||
      !truncateHead(block.text).truncated
    ) {
      return { kind: "continue", context };
    }
    try {
      const { AstOutlineManager, isSupportedOutlinePath } = await import("./ast/outline.js");
      if (!isSupportedOutlinePath(state.source)) {
        return { kind: "continue", context };
      }
      const format = (outline: SourceViewBlock): string =>
        [
          `AST overview of ${outline.path}, source lines 1-${outline.totalLines}: the requested text exceeded the read buffer.`,
          "Source line numbers are on the left. Detail is reduced to fit the buffer; omitted bodies are not exact source text. Read a small source range when needed.",
          ...outline.renderedLines.map(
            (line) => `${line.sourceLine?.lineNumber ?? "…"} | ${line.text}`,
          ),
        ].join("\n");
      context.resolverContext.signal?.throwIfAborted();
      const outline = await new AstOutlineManager(12).readDocumentOutline(
        state.source,
        context.resolverContext.cwd,
        state.text.lines.map((line) => line.content),
        (candidate) => {
          context.resolverContext.signal?.throwIfAborted();
          return !truncateHead(format(candidate)).truncated;
        },
      );
      const text = format(outline);
      // Even a pathological source label must respect the output budget.
      if (truncateHead(text).truncated) {
        return { kind: "continue", context };
      }
      return {
        kind: "return",
        result: {
          content: [{ type: "text", text }],
          details: { source: state.source, resolvedBy: "ast-overflow" },
        },
      };
    } catch {
      context.resolverContext.signal?.throwIfAborted();
      return { kind: "continue", context };
    }
  };
}
