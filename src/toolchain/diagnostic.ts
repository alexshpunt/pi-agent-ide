import type { Diagnostic } from "./types.js";

export function formatDiagnostic(diagnostic: Diagnostic, source?: string): string {
  const code = source === undefined ? diagnostic.code : `${source}:${diagnostic.code}`;
  return `[${diagnostic.severity.toUpperCase()}] ${code}: ${diagnostic.message}`;
}
