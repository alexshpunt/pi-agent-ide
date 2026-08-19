import path from "node:path";

import { formatDiagnostic } from "#src/toolchain/diagnostic.js";

import type { Diagnostic } from "#src/toolchain/types.js";
import type { SourceMappedTextContent } from "./source-view.js";
import type { TextSourceLine } from "pi-agent-text";

export function resolveDiagnosticViewPath(source: string, scheme: string, cwd: string): string | undefined
{
    const prefix = `${scheme}:`;

    if (!source.startsWith(prefix))
    {
        return undefined;
    }

    const requestedPath = source.slice(prefix.length);

    if (requestedPath.length === 0)
    {
        throw new Error(`${scheme}: requires a file path.`);
    }

    return path.resolve(cwd, requestedPath);
}

export function formatDiagnosticViewSource(scheme: string, filePath: string): string
{
    return `${scheme}:${filePath}`;
}

export function createDiagnosticViewContent(
    filePath: string,
    text: string,
    diagnostics: readonly Diagnostic[],
    source: string,
): SourceMappedTextContent
{
    const fileLines = text.split(/\r\n|\r|\n/u);
    const diagnosticsByLine = new Map<number, Diagnostic[]>();

    for (const diagnostic of diagnostics)
    {
        if (!Number.isInteger(diagnostic.line) || diagnostic.line < 1 || diagnostic.line > fileLines.length)
        {
            continue;
        }

        const lineDiagnostics = diagnosticsByLine.get(diagnostic.line) ?? [];
        lineDiagnostics.push(diagnostic);
        diagnosticsByLine.set(diagnostic.line, lineDiagnostics);
    }

    if (diagnosticsByLine.size === 0)
    {
        return {
            type: "text",
            text: `No ${source} diagnostics.`,
            sourceLines: {},
        };
    }

    const renderedLines: string[] = [];
    const sourceLines: Record<string, TextSourceLine> = {};

    for (const [lineNumber, lineDiagnostics] of [...diagnosticsByLine].sort(([left], [right]) => left - right))
    {
        const content = fileLines[lineNumber - 1] ?? "";
        const annotations = lineDiagnostics
            .map((diagnostic) => `<!-- ${source}: ${formatDiagnostic(diagnostic, source)} -->`)
            .join(" ");
        renderedLines.push(`${content}  ${annotations}`);
        sourceLines[String(renderedLines.length)] = { source: filePath, lineNumber, content };
    }

    return {
        type: "text",
        text: renderedLines.join("\n"),
        sourceLines,
    };
}
