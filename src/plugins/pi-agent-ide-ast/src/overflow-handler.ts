import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { ReadOutputReducer, ReadPostReadHandler } from "pi-agent-read/api/tools/read";
import type { SourceViewBlock } from "pi-agent-ide/api/code-view";

/** Builds a compact source view from recorded text, never from a newer filesystem snapshot. */
export const reduceAstReadOutput: ReadOutputReducer = async (result, context, budget) => {
  const { source, resolvedBy, lines, totalLines, startLine } = result.details;
  if (
    source === undefined ||
    (resolvedBy !== "filesystem" && !source.startsWith("ssh://")) ||
    lines === undefined ||
    lines.length !== totalLines ||
    (startLine !== undefined && startLine !== 1)
  )
    return undefined;
  try {
    const { AstOutlineManager, isSupportedOutlinePath } = await import("./ast/outline.js");
    if (!isSupportedOutlinePath(source)) return undefined;
    const format = (outline: SourceViewBlock): string =>
      [
        `Code overview of ${outline.path}, source lines 1-${outline.totalLines}: the requested text exceeded the output limit.`,
        `Some source text is omitted. Read ${JSON.stringify(source)} with offset and limit for exact source text.`,
        ...outline.renderedLines.map(
          (line) => `${line.sourceLine?.lineNumber ?? "…"} | ${line.text}`,
        ),
      ].join("\n");
    context.signal?.throwIfAborted();
    const outline = await new AstOutlineManager(12).readDocumentOutline(
      source,
      context.cwd,
      lines.map((line) => line.content),
      (candidate) => {
        context.signal?.throwIfAborted();
        return !truncateHead(format(candidate), budget).truncated;
      },
    );
    const text = format(outline);
    if (truncateHead(text, budget).truncated) return undefined;
    return {
      // The outline is presentation only; structured readers still receive exact source data.
      script: result.script,
      content: [{ type: "text", text }],
      details: { source, resolvedBy: "ast-overflow" },
    };
  } catch {
    context.signal?.throwIfAborted();
    return undefined;
  }
};

/** Present an overflowing read window as an outline without losing its source data. */
export function createAstOverflowHandler(): ReadPostReadHandler {
  return async (context) => {
    const { state, result } = context;
    const block = result?.content.length === 1 ? result.content[0] : undefined;
    if (
      context.audience === "script" ||
      result === undefined ||
      state?.contentKind !== "text" ||
      (state.resolvedBy !== "filesystem" && !state.source.startsWith("ssh://")) ||
      block?.type !== "text" ||
      !truncateHead(block.text).truncated
    )
      return { kind: "continue", context };
    const reduced = await reduceAstReadOutput(
      {
        ...result,
        details: {
          ...result.details,
          source: state.source,
          resolvedBy: state.resolvedBy,
          lines: state.text.lines,
          startLine: 1,
          totalLines: state.text.lines.length,
        },
      },
      context.resolverContext,
      { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },
    );
    return reduced === undefined
      ? { kind: "continue", context }
      : {
          kind: "continue",
          context,
          // Keep canonical data added by other post-read transforms, including source targets.
          transform: (result) => ({ ...reduced, script: result.script }),
        };
  };
}
