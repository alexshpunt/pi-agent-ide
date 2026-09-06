import { requiredValue } from "pi-agent-invariant";
import type { DiagnosticParserConfig } from "pi-agent-ide/api/tool-config";
import type { Diagnostic } from "pi-agent-ide/api/toolchain";

/**
Parses supported linter outputs into the shared diagnostic contract.
*/
export function parseDiagnostics(output: string, config: DiagnosticParserConfig): Diagnostic[] {
  if (output.trim().length === 0) {
    return [];
  }

  switch (config.format) {
    case "pi-json": {
      return parsePiJson(output);
    }
    case "eslint-json": {
      return parseEslintJson(output);
    }
    case "sarif": {
      return parseSarif(output);
    }
    case "checkstyle": {
      return parseCheckstyle(output);
    }
    case "gcc":
    case "clang": {
      return parseCompilerLines(output);
    }
    case "regex": {
      return parseRegexLines(output, requiredValue(config.pattern));
    }
  }
}

function parsePiJson(output: string): Diagnostic[] {
  const value = JSON.parse(output) as { diagnostics?: unknown };
  return Array.isArray(value.diagnostics) ? value.diagnostics.flatMap(normalizeDiagnostic) : [];
}

function parseEslintJson(output: string): Diagnostic[] {
  const files = JSON.parse(output) as { messages?: unknown }[];
  return files.flatMap((file) =>
    Array.isArray(file.messages) ? file.messages.flatMap(normalizeDiagnostic) : [],
  );
}

function parseSarif(output: string): Diagnostic[] {
  const sarif = JSON.parse(output) as { runs?: { results?: Record<string, unknown>[] }[] };
  return (sarif.runs ?? []).flatMap((run) =>
    (run.results ?? []).flatMap((result) => {
      const location =
        (
          result.locations as
            | { physicalLocation?: { region?: Record<string, unknown> } }[]
            | undefined
        )?.[0]?.physicalLocation?.region ?? {};
      const message = result.message as { text?: unknown } | undefined;
      return normalizeDiagnostic({
        line: location.startLine,
        column: location.startColumn,
        message: message?.text,
        code: result.ruleId,
        severity: sarifSeverity(result.level),
      });
    }),
  );
}

function parseCheckstyle(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const pattern = /<error\s+([^>]+?)\/?>(?:<\/error>)?/gu;

  for (const match of output.matchAll(pattern)) {
    const attributes = Object.fromEntries(
      [...requiredValue(match[1]).matchAll(/([\w-]+)="([^"]*)"/gu)].map((item) => [
        requiredValue(item[1]),
        decodeXml(requiredValue(item[2])),
      ]),
    );
    diagnostics.push(
      ...normalizeDiagnostic({
        line: Number(attributes.line),
        column: Number(attributes.column ?? 1),
        message: attributes.message,
        code: attributes.source,
        severity: attributes.severity,
      }),
    );
  }

  return diagnostics;
}

function parseCompilerLines(output: string): Diagnostic[] {
  const pattern =
    /^(?<file>.+?):(?<line>\d+):(?<column>\d+):\s*(?<severity>fatal error|error|warning|note|info|hint):\s*(?<message>.*?)(?:\s+\[(?<code>[^\]]+)\])?$/u;
  return parseMatchingLines(output, pattern);
}

function parseRegexLines(output: string, source: string): Diagnostic[] {
  return parseMatchingLines(output, new RegExp(source, "u"));
}

function parseMatchingLines(output: string, pattern: RegExp): Diagnostic[] {
  return output.split(/\r?\n/u).flatMap((line) => {
    const groups = line.match(pattern)?.groups;

    if (groups === undefined) {
      return [];
    }

    return normalizeDiagnostic(groups);
  });
}

function normalizeDiagnostic(value: unknown): Diagnostic[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }

  const item = value as Record<string, unknown>;
  const line = numberValue(item.line ?? item.startLine);
  const column = numberValue(item.column ?? item.startColumn, 1);
  const message = typeof item.message === "string" ? item.message : undefined;

  if (line === undefined || message === undefined) {
    return [];
  }

  return [
    {
      code: stringValue(item.code ?? item.ruleId, "lint"),
      message,
      line,
      column: column ?? 1,
      severity: severityValue(item.severity),
    },
  ];
}

function numberValue(value: unknown, fallback?: number): number | undefined {
  const number = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof number === "number" && Number.isInteger(number) && number >= 1 ? number : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function severityValue(value: unknown): Diagnostic["severity"] {
  if (value === 2) return "error";
  if (value === 1) return "warning";
  const normalized = stringValue(value, "warning").toLowerCase();

  if (normalized.includes("error")) {
    return "error";
  }

  if (normalized === "info" || normalized === "note" || normalized === "notice") {
    return "info";
  }

  if (normalized === "hint") {
    return "hint";
  }

  return "warning";
}

function sarifSeverity(value: unknown): string {
  return value === "error" || value === "warning" || value === "note" ? value : "warning";
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
