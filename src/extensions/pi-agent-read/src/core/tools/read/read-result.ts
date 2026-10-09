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
import {
  ResourceError,
  type AgentContent,
  type ImageContent,
  type TextContent,
} from "pi-agent-resource";

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
  readonly audience?: "agent" | "script";
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
        message:
          "Line ranges require textual content. Omit offset and limit to read this content without a line range.",
      });
    }

    const projected = projectAgentContent(state.content);

    return {
      script: { kind: "native", source: state.source, blocks: state.content },
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
    script: {
      kind: "text",
      ...(state.text.references === undefined ? {} : { references: state.text.references }),
      source: state.source,
      content: lines.map((line) => line.content + line.lineEnding).join(""),
      lines,
      startLine: lines[0]?.lineNumber ?? 0,
      endLine: lines.at(-1)?.lineNumber ?? 0,
      totalLines,
    },
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

function readFailureMessage(failure: ReadFailure): string {
  let cause = failure.cause;
  let error: Error | undefined;
  const visited = new Set<Error>();
  while (cause instanceof Error && !visited.has(cause)) {
    visited.add(cause);
    error = cause;
    cause = cause.cause;
  }
  const code = error !== undefined && "code" in error ? error.code : undefined;
  let reason = error?.message || failure.message;
  if (code === "ENOENT")
    reason = failure.candidates?.length
      ? "Source not found."
      : "Source not found. Search for the correct path.";
  else if (code === "EACCES" || code === "EPERM") reason = "Access denied.";
  else if (failure.code === "INVALID_RESOLVER_RESULT")
    reason = "The source provider returned an invalid result.";
  else if (failure.code === "INVALID_RESOURCE_CONTENT")
    reason = "The source provider returned invalid content.";
  else if (failure.code === "UNSUPPORTED_CAPABILITY")
    reason = "This source does not support reading.";
  else if (failure.code === "NO_RESOLVER")
    reason = "This source is not supported. Choose a supported source from the path parameter.";
  else if (failure.code === "NO_FRAGMENT_RESOLVER")
    reason = "This anchor is not supported. Read the source without the anchor.";
  if (failure.code === "INVALID_REQUEST")
    reason += ". Supply path with a source or an unchanged result reference.";
  else if (failure.code === "FRAGMENT_FAILED" && failure.source !== undefined)
    reason += `\nRead ${JSON.stringify(failure.source)} with views=["anchors"] and choose a current anchor.`;
  const source = failure.source === undefined ? "" : ` for ${JSON.stringify(failure.source)}`;
  return `Read failed${source}: ${reason}`;
}

/** Describe a caller-cancelled failed Read without changing its private record or exceptions. */
export function withReadCancellation(
  result: ReadToolResult,
  requestedSource: string | undefined,
  signal: AbortSignal | undefined,
): ReadToolResult {
  if (!signal?.aborted || !result.isError) return result;
  const source = result.details.source ?? result.details.failure?.source ?? requestedSource;
  return {
    ...result,
    content: [
      {
        type: "text",
        text: `Read cancelled${source === undefined ? "" : ` for ${JSON.stringify(source)}`}. No completed result was returned.`,
      },
    ],
  };
}

/** Show an actionable failure while retaining the original record for private adapters. */
export function failureResult(failure: ReadFailure): ReadToolResult {
  const safe = failure.cause instanceof ResourceError ? failure.cause : undefined;
  if (safe !== undefined) {
    failure = {
      ...failure,
      source: failure.source ?? safe.source,
      message: `${safe.code}: ${failure.source ?? safe.source}`,
      cause: new ResourceError(safe.code, safe.source, safe.effect),
    };
  } else if (
    failure.cause instanceof Error &&
    "code" in failure.cause &&
    !["ENOENT", "EACCES", "EPERM"].includes(String(failure.cause.code))
  ) {
    failure = {
      ...failure,
      message: `${failure.code}: ${failure.source ?? "source"}`,
      cause: undefined,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: [
          readFailureMessage(failure),
          ...(failure.candidates?.length
            ? [
                "",
                "Possible matches:",
                ...failure.candidates.map((candidate) => `- ${JSON.stringify(candidate.path)}`),
                "",
                "Retry read with an exact candidate path.",
              ]
            : []),
        ].join("\n"),
      },
    ],
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
