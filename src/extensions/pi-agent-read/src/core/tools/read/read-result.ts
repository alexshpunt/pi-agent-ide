import { createTextDocument, renderPresentedTextDocument } from "pi-agent-text";

import type {
  ReadFailure,
  ReadRequest,
  ReadResultDetails,
  ReadState,
  ReadTextState,
  ReadToolResult,
  UnsupportedContentBlockDetail,
} from "#src/api/tools/read.js";
import type { AgentContent, ImageContent, TextContent } from "pi-agent-resource";

export function createReadState(
  content: AgentContent,
  source: string,
  resolverId: string,
  options: { readonly preserveTruncatedOutput: boolean; readonly textMode: "final" | "normal" },
): ReadState {
  if (!isSingleTextContent(content)) {
    return {
      content,
      source,
      resolvedBy: resolverId,
      preserveTruncatedOutput: options.preserveTruncatedOutput,
      textMode: options.textMode,
      contentKind: "other",
    };
  }

  const text = content[0].text;

  return {
    content,
    source,
    resolvedBy: resolverId,
    preserveTruncatedOutput: options.preserveTruncatedOutput,
    textMode: options.textMode,
    contentKind: "text",
    text: createTextDocument(source, text),
  };
}

export interface ReadProjectionOptions {
  /** Absolute 1-based line where an anchored read's window starts. */
  readonly originLine?: number;
}

export function projectReadState(
  state: ReadState,
  request: ReadRequest,
  options?: ReadProjectionOptions,
): ReadToolResult {
  if (state.contentKind !== "text") {
    if (request.offset !== undefined || request.limit !== undefined) {
      return failureResult({
        code: "UNSUPPORTED_RANGE",
        source: state.source,
        resolverId: state.resolvedBy,
        message: "Line ranges require textual content",
      });
    }

    const projected = projectAgentContent(state.content);

    return {
      content: projected.content,
      details: {
        ...readDetails(state),
        ...(projected.unsupportedContentBlocks !== undefined && {
          unsupportedContentBlocks: projected.unsupportedContentBlocks,
        }),
      },
    };
  }

  const totalLines = state.text.lines.length;
  const range = resolveTextRange(request, totalLines, options?.originLine);
  const lines = state.text.lines.slice(range.startIndex, range.endIndex);
  const renderedText =
    state.textMode === "final"
      ? renderFinalTextLines(lines, range.endIndex < totalLines)
      : renderPresentedTextDocument({
          ...state.text,
          lines: lines.map((line, index) => ({
            ...line,
            lineEnding:
              index === lines.length - 1 && range.endIndex < totalLines ? "" : line.lineEnding,
          })),
        });
  const originalBlock = state.content[0];
  const content: TextContent[] = [
    {
      type: "text",
      text: renderedText,
      ...(originalBlock.textSignature !== undefined && {
        textSignature: originalBlock.textSignature,
      }),
    },
  ];

  return {
    content,
    details: {
      ...readDetails(state),
      startLine: lines[0]?.lineNumber ?? 0,
      endLine: lines.at(-1)?.lineNumber ?? 0,
      totalLines,
      lines,
    },
  };
}

function renderFinalTextLines(
  lines: ReadTextState["text"]["lines"],
  stoppedEarly: boolean,
): string {
  return lines
    .map(
      (line, index) =>
        `${line.content}${index === lines.length - 1 && stoppedEarly ? "" : line.lineEnding}`,
    )
    .join("");
}

export function failureResult(failure: ReadFailure): ReadToolResult {
  return {
    content: [{ type: "text", text: `${failure.code}: ${failure.message}` }],
    details: { failure },
    isError: true,
  };
}

function readDetails(state: ReadState): ReadResultDetails {
  return { source: state.source, resolvedBy: state.resolvedBy };
}

function projectAgentContent(content: AgentContent): {
  readonly content: (TextContent | ImageContent)[];
  readonly unsupportedContentBlocks?: readonly [
    UnsupportedContentBlockDetail,
    ...UnsupportedContentBlockDetail[],
  ];
} {
  const projected: (TextContent | ImageContent)[] = [];
  const unsupported: UnsupportedContentBlockDetail[] = [];

  for (const [index, block] of content.entries()) {
    if (block.type !== "custom") {
      projected.push(block);
      continue;
    }

    unsupported.push({ index, kind: block.kind });
    projected.push({
      type: "text",
      text: `[unsupported_content_block kind=${block.kind} index=${index}]`,
    });
  }

  const firstUnsupported = unsupported[0];

  return {
    content: projected,
    ...(firstUnsupported !== undefined && {
      unsupportedContentBlocks: [firstUnsupported, ...unsupported.slice(1)] as const,
    }),
  };
}

function resolveTextRange(
  request: ReadRequest,
  totalLines: number,
  originLine?: number,
): { startIndex: number; endIndex: number } {
  const offset = request.offset === undefined ? 1 : Math.trunc(request.offset);
  const startLine = anchoredStartLine(offset, totalLines, originLine);
  const limit = request.limit === undefined ? totalLines : Math.max(0, Math.trunc(request.limit));

  return {
    startIndex: Math.min(totalLines, startLine - 1),
    endIndex: Math.min(totalLines, startLine - 1 + limit),
  };
}

/** Resolves the absolute window start; anchored reads count offsets from their origin. */
export function anchoredStartLine(
  offset: number,
  totalLines: number,
  originLine: number | undefined,
): number {
  if (originLine === undefined) {
    return offset < 0 ? Math.max(1, totalLines + offset + 1) : Math.max(1, offset);
  }

  const requested = offset < 0 ? originLine + offset : originLine + Math.max(1, offset) - 1;
  return Math.max(1, requested);
}

function isSingleTextContent(content: AgentContent): content is readonly [TextContent] {
  return content.length === 1 && content[0].type === "text";
}
