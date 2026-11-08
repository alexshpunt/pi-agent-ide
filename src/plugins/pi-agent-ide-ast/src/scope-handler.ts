import type { AstScopeManager, ScopeEntry } from "./ast/manager.js";
import type {
  ReadPostReadHandler,
  ReadTextLine,
  ReadToolResult,
} from "pi-agent-read/api/tools/read";
import type { TextLinePresenter } from "pi-agent-text";

const AST_SCOPE_METADATA = "pi-agent-ast";

interface AstScopeBoundary {
  readonly beginAnchor: string;
  readonly endAnchor: string;
  readonly endLine: number;
}

interface AstScopeLineMetadata {
  readonly boundaries?: readonly AstScopeBoundary[];
}

export function createAstScopePresenter(manager: AstScopeManager): TextLinePresenter {
  return {
    id: "ast-scopes",
    async present(document, context) {
      if (context.resolvedBy !== "filesystem" && !document.source.startsWith("ssh://")) {
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

    const fullLineByNumber = lineLookup(state.text.lines);
    // Built on the first scope boundary: reads without scope markers do not need it.
    let renderedLineNumbers: ReadonlySet<number> | undefined;
    const contextLines = new Map<number, ReadTextLine>();

    // Indexed loops: a whole-file read of a large file passes every line through here, and
    // most lines have no scope boundary.
    for (let index = 0; index < renderedLines.length; index += 1) {
      const lineNumber = renderedLines[index]?.lineNumber;
      const boundaries =
        lineNumber === undefined
          ? undefined
          : getAstScopeMetadata(fullLineByNumber.get(lineNumber))?.boundaries;
      if (boundaries === undefined) continue;

      for (const boundary of boundaries) {
        renderedLineNumbers ??= new Set(renderedLines.map((line) => line.lineNumber));
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
    const lastRenderedLine = renderedLines.at(-1);

    return {
      kind: "continue",
      context,
      transform: (updated) => appendTextLines(updated, lines, lastRenderedLine),
    };
  };
}

/**
 * Finds a line by its number. Read lines are numbered from 1 in order, so the line usually sits
 * at its index; an index is built only for documents numbered differently. Building it for
 * every read would cost one map entry per line of a large file.
 */
function lineLookup(lines: readonly ReadTextLine[]): {
  get(lineNumber: number): ReadTextLine | undefined;
} {
  let byNumber: Map<number, ReadTextLine> | undefined;
  return {
    get(lineNumber) {
      const line = lines[lineNumber - 1];
      if (line?.lineNumber === lineNumber) return line;
      byNumber ??= new Map(lines.map((candidate) => [candidate.lineNumber, candidate]));
      return byNumber.get(lineNumber);
    },
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
    boundaries.push({
      endLine: scope.endLine,
      beginAnchor: scope.beginAnchor.value,
      endAnchor: scope.endScopeAnchor.value,
    });
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
        anchors: [...new Set([...(line.anchors ?? []), ...markers])],
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
