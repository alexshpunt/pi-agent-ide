import path from "node:path";

import { formatDiagnostic } from "#src/toolchain/diagnostic.js";

import type { Diagnostic } from "#src/toolchain/types.js";
import type { SourceMappedTextContent } from "./source-view.js";
import type { TextDocument, TextSourceLine } from "pi-agent-text";

/** Diagnostics produced by one named source such as `lsp` or `lint`. */
export interface DiagnosticSource {
  readonly source: string;
  readonly diagnostics: readonly Diagnostic[];

  readonly status?: "ready" | "pending" | "unavailable" | "snapshot" | "unversioned";
  readonly reason?: string;
}

/** Controls the source context projected around diagnostic lines. */
export interface DiagnosticViewOptions {
  readonly contextLines?: number;
}

export function resolveDiagnosticViewPath(
  source: string,
  scheme: string,
  cwd: string,
): string | undefined {
  const prefix = `${scheme}:`;

  if (!source.startsWith(prefix)) {
    return undefined;
  }

  const requestedPath = source.slice(prefix.length);

  if (requestedPath.length === 0) {
    throw new Error(`${scheme}: requires a file path.`);
  }

  return path.resolve(cwd, requestedPath);
}

export function formatDiagnosticViewSource(scheme: string, filePath: string): string {
  return `${scheme}:${filePath}`;
}

/** Builds a source-mapped diagnostic read with merged context around every diagnostic line. */
export function createDiagnosticViewContent(
  filePath: string,
  text: string,
  sources: readonly DiagnosticSource[],
  options: DiagnosticViewOptions = {},
): SourceMappedTextContent {
  const fileLines = text.split(/\r\n|\r|\n/u);
  const diagnosticsByLine = diagnosticsByValidLine(sources, fileLines.length);

  if (diagnosticsByLine.size === 0) {
    return {
      type: "text",
      text: diagnosticStatus(sources) || "No diagnostics.",
      sourceLines: {},
    };
  }

  const contextLines = options.contextLines ?? 5;

  if (!Number.isInteger(contextLines) || contextLines < 0) {
    throw new TypeError("Diagnostic contextLines must be a non-negative integer.");
  }

  const includedLines = new Set<number>();
  for (const diagnosticLine of diagnosticsByLine.keys()) {
    const first = Math.max(1, diagnosticLine - contextLines);
    const last = Math.min(fileLines.length, diagnosticLine + contextLines);

    for (let lineNumber = first; lineNumber <= last; lineNumber += 1) {
      includedLines.add(lineNumber);
    }
  }

  const status = diagnosticStatus(sources);
  const renderedLines: string[] = status ? [status] : [];
  const sourceLines: Record<string, TextSourceLine> = {};

  for (const lineNumber of [...includedLines].sort((left, right) => left - right)) {
    const content = fileLines[lineNumber - 1] ?? "";
    const annotations = (diagnosticsByLine.get(lineNumber) ?? [])
      .map(
        ({ diagnostic, source }) => `<!-- ${source}: ${formatDiagnostic(diagnostic, source)} -->`,
      )
      .join(" ");
    renderedLines.push(annotations.length === 0 ? content : `${content}  ${annotations}`);
    sourceLines[String(renderedLines.length)] = { source: filePath, lineNumber, content };
  }

  return {
    type: "text",
    text: renderedLines.join("\n"),
    sourceLines,
  };
}

/** Adds named diagnostic annotations to their source lines without filtering the document. */
export function addDiagnosticAnnotations(
  document: TextDocument,
  sources: readonly DiagnosticSource[],
): TextDocument {
  const diagnostics = diagnosticsByValidLine(sources, document.lines.length);

  const lines = document.lines.map((line) => {
    const annotations = diagnostics.get(line.lineNumber);

    if (annotations === undefined) {
      return line;
    }

    const suffix = annotations
      .map(
        ({ diagnostic, source }) => `<!-- ${source}: ${formatDiagnostic(diagnostic, source)} -->`,
      )
      .join(" ");

    return {
      ...line,
      presentation: {
        ...line.presentation,
        suffix: `${line.presentation?.suffix ?? ""}  ${suffix}`,
      },
    };
  });

  return { ...document, lines };
}

/** Describe incomplete or unverified sources without treating missing results as clean. */
export function diagnosticStatus(sources: readonly DiagnosticSource[]): string {
  return sources
    .filter((source) => source.status && source.status !== "ready")
    .map(
      (source) =>
        `${source.source}: ${source.status}${source.reason ? ` (${source.reason})` : ""}.`,
    )
    .join(" ");
}

interface NamedDiagnostic {
  readonly source: string;
  readonly diagnostic: Diagnostic;
}

function diagnosticsByValidLine(
  sources: readonly DiagnosticSource[],
  lineCount: number,
): Map<number, NamedDiagnostic[]> {
  const diagnosticsByLine = new Map<number, NamedDiagnostic[]>();

  for (const { diagnostics, source } of sources) {
    for (const diagnostic of diagnostics) {
      if (
        !Number.isInteger(diagnostic.line) ||
        diagnostic.line < 1 ||
        diagnostic.line > lineCount
      ) {
        continue;
      }

      const lineDiagnostics = diagnosticsByLine.get(diagnostic.line) ?? [];
      lineDiagnostics.push({ diagnostic, source });
      diagnosticsByLine.set(diagnostic.line, lineDiagnostics);
    }
  }

  return diagnosticsByLine;
}
