import type { AstScopeManager, ScopeEntry } from "./ast/manager.js";
import type {
  ReadPostReadHandler,
  ReadTextLine,
  ReadToolResult,
} from "pi-agent-read/api/tools/read";
import type { TextLinePresenter } from "pi-agent-text";

const AST_SCOPE_METADATA = "pi-agent-ast";

interface AstScopeBoundary {
  readonly endLine: number;
}

interface AstScopeLineMetadata {
  readonly boundaries?: readonly AstScopeBoundary[];
}

export function createAstScopePresenter(manager: AstScopeManager): TextLinePresenter {
  return {
    id: "ast-scopes",
    async present(document, context) {
      if (context.resolvedBy !== "filesystem") {
        return document;
      }

      try {
        const scopes = await manager.getDocumentScopes(
          document.source,
          context.cwd,
          document.lines.map((line) => line.content),
        );
        const lines = addScopeMarkers(document.lines, scopes);
        return lines === document.lines ? document : { ...document, lines };
      } catch {
        return document;
      }
    },
  };
}

export function createAstScopePostReadHandler(): ReadPostReadHandler {
  return (context) => {
    const state = context.state;
    const result = context.result;

    if (state?.contentKind !== "text" || result === undefined) {
      return { kind: "continue", context };
    }

    const renderedLines = result.details.lines;

    if (renderedLines === undefined) {
      return { kind: "continue", context };
    }

    const fullLineByNumber = new Map(state.text.lines.map((line) => [line.lineNumber, line]));
    const renderedLineNumbers = new Set(renderedLines.map((line) => line.lineNumber));
    const contextLines = new Map<number, ReadTextLine>();

    for (const renderedLine of renderedLines) {
      const sourceLine = fullLineByNumber.get(renderedLine.lineNumber);
      const metadata = getAstScopeMetadata(sourceLine);

      for (const boundary of metadata?.boundaries ?? []) {
        if (renderedLineNumbers.has(boundary.endLine)) {
          continue;
        }

        const endLine = fullLineByNumber.get(boundary.endLine);

        if (endLine !== undefined) {
          contextLines.set(boundary.endLine, endLine);
        }
      }
    }

    if (contextLines.size === 0) {
      return { kind: "continue", context };
    }

    const appendedLines = [...contextLines.values()].sort(
      (left, right) => left.lineNumber - right.lineNumber,
    );
    const lines = [...renderedLines, ...appendedLines];
    const updatedResult = appendTextLines(result, lines, renderedLines.at(-1));

    return { kind: "continue", context: { ...context, result: updatedResult } };
  };
}

function addScopeMarkers(
  lines: readonly ReadTextLine[],
  scopes: readonly ScopeEntry[],
): readonly ReadTextLine[] {
  if (scopes.length === 0) {
    return lines;
  }

  const markersByLine = new Map<number, string[]>();
  const boundariesByLine = new Map<number, AstScopeBoundary[]>();

  for (const scope of scopes) {
    const begin = markersByLine.get(scope.startLine) ?? [];
    begin.push(scope.beginAnchor.value);
    markersByLine.set(scope.startLine, begin);

    const boundaries = boundariesByLine.get(scope.startLine) ?? [];
    boundaries.push({ endLine: scope.endLine });
    boundariesByLine.set(scope.startLine, boundaries);

    const end = markersByLine.get(scope.endLine) ?? [];
    end.push(scope.endScopeAnchor.value);
    markersByLine.set(scope.endLine, end);
  }

  return lines.map((line) => {
    const markers = markersByLine.get(line.lineNumber);
    const boundaries = boundariesByLine.get(line.lineNumber);

    if (markers === undefined && boundaries === undefined) {
      return line;
    }

    return {
      ...line,
      ...(markers !== undefined && {
        presentation: {
          ...line.presentation,
          suffix: `${line.presentation?.suffix ?? ""}${markers
            .map((marker) => `  <!-- ${marker} -->`)
            .join("")}`,
        },
      }),
      metadata: {
        ...line.metadata,
        [AST_SCOPE_METADATA]: {
          ...getAstScopeMetadata(line),
          ...(boundaries !== undefined && { boundaries }),
        } satisfies AstScopeLineMetadata,
      },
    };
  });
}

function getAstScopeMetadata(line: ReadTextLine | undefined): AstScopeLineMetadata | undefined {
  const value = line?.metadata?.[AST_SCOPE_METADATA];

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value;
}

function appendTextLines(
  result: ReadToolResult,
  lines: readonly ReadTextLine[],
  lastRenderedLine: ReadTextLine | undefined,
): ReadToolResult {
  const block = result.content.length === 1 ? result.content[0] : undefined;

  if (block?.type !== "text" || result.details.lines === undefined) {
    return result;
  }

  const appendedLines = lines.slice(result.details.lines.length);

  if (appendedLines.length === 0) {
    return result;
  }

  const separator =
    lastRenderedLine?.lineEnding !== undefined && lastRenderedLine.lineEnding.length > 0
      ? lastRenderedLine.lineEnding
      : appendedLines[0]?.lineEnding !== undefined && appendedLines[0].lineEnding.length > 0
        ? appendedLines[0].lineEnding
        : "\n";
  const appendedText = appendedLines
    .map((line, index) => {
      const isLast = index === appendedLines.length - 1;
      const lineEnding = isLast ? line.lineEnding : line.lineEnding || separator;
      const prefix = line.presentation?.prefix ?? "";
      const suffix = line.presentation?.suffix ?? "";
      return `${prefix}${line.content}${suffix}${lineEnding}`;
    })
    .join("");
  const separatorBeforeContext = /(?:\r\n|\r|\n)$/.test(block.text) ? "" : separator;
  const text = `${block.text}${separatorBeforeContext}${appendedText}`;

  return {
    ...result,
    content: [
      {
        ...block,
        text,
      },
    ],
    details: {
      ...result.details,
      lines,
    },
  };
}
