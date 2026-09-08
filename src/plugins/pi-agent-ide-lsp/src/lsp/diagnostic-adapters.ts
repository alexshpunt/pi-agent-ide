import type { Diagnostic } from "pi-agent-ide/api/toolchain";
import type { LspClient } from "./client.js";

/** A server capability that returns completed diagnostics rather than intermediate pushes. */
export interface CompletedDiagnosticAdapter {
  readonly command: string;
  request(client: LspClient, uri: string, signal: AbortSignal): Promise<Diagnostic[]>;
}

const typescript: CompletedDiagnosticAdapter = {
  command: "typescript.tsserverRequest",
  async request(client, uri, signal) {
    const reports = await Promise.all(
      ["syntacticDiagnosticsSync", "semanticDiagnosticsSync", "suggestionDiagnosticsSync"].map(
        async (command) => {
          const response = await client.sendRequest(
            "workspace/executeCommand",
            {
              command: "typescript.tsserverRequest",
              arguments: [
                command,
                { file: uri, includeLinePosition: true },
                { isAsync: false, expectsResult: true },
              ],
            },
            signal,
          );
          if (!isRecord(response) || response.success !== true || !Array.isArray(response.body))
            throw new Error(`Invalid completed TypeScript diagnostic report: ${command}`);
          return response.body.map(convertTypeScriptDiagnostic);
        },
      ),
    );
    return reports.flat();
  },
};

/** Select by advertised server capability, never by file extension or configured server name. */
export function completedDiagnosticAdapter(
  client: LspClient,
): CompletedDiagnosticAdapter | undefined {
  return client.supportsCommand(typescript.command) ? typescript : undefined;
}

function convertTypeScriptDiagnostic(value: unknown): Diagnostic {
  if (
    !isRecord(value) ||
    typeof value.message !== "string" ||
    (typeof value.code !== "number" && typeof value.code !== "string") ||
    !isRecord(value.startLocation) ||
    !Number.isInteger(value.startLocation.line) ||
    !Number.isInteger(value.startLocation.offset) ||
    Number(value.startLocation.line) < 1 ||
    Number(value.startLocation.offset) < 1 ||
    !["error", "warning", "suggestion", "message"].includes(String(value.category))
  )
    throw new Error("Invalid TypeScript diagnostic entry");
  return {
    code: String(value.code),
    message: value.message,
    line: Number(value.startLocation.line),
    column: Number(value.startLocation.offset),
    severity:
      value.category === "error"
        ? "error"
        : value.category === "warning"
          ? "warning"
          : value.category === "suggestion"
            ? "hint"
            : "info",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
