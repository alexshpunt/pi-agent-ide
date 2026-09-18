import { readFile } from "node:fs/promises";
import { URI } from "vscode-uri";
import { DiagnosticSeverity, type LspDiagnostic } from "./types.js";
import type { LspClient } from "./client.js";

import { completedDiagnosticAdapter } from "./diagnostic-adapters.js";
import type { Diagnostic } from "pi-agent-ide/api/toolchain";

/** LSP diagnostics do not reliably distinguish parser errors from type errors. */
export interface LspDiagnosticResult {
  diagnostics: Diagnostic[];
  syntaxErrors: Diagnostic[];
  otherDiagnostics: Diagnostic[];
  unversioned: boolean;

  /** False for push snapshots, even when a publication carries a document version. */
  complete: boolean;
}

/** Request current diagnostics using pull when supported, otherwise a version-aware push wait. */
export async function requestDiagnostics(
  client: LspClient,
  uri: string,
  languageId?: string,
  options: { signal?: AbortSignal; content?: string } = {},
): Promise<LspDiagnosticResult> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  const timeout = setTimeout(
    () => controller.abort(new Error(`[lsp] ${client.serverId}: diagnostics timed out for ${uri}`)),
    client.timeoutMs,
  );
  try {
    return await requestCurrentDiagnostics(client, uri, languageId, options.content, signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestCurrentDiagnostics(
  client: LspClient,
  uri: string,
  languageId: string | undefined,
  content: string | undefined,
  signal: AbortSignal,
): Promise<LspDiagnosticResult> {
  signal.throwIfAborted();
  if (client.diagnosticMode !== "push") {
    const version = client.documentVersion(uri);
    try {
      const raw = await client.sendRequest<{ kind: string; items?: LspDiagnostic[] }>(
        "textDocument/diagnostic",
        { textDocument: { uri } },
        signal,
      );
      if (raw.kind !== "full" || !Array.isArray(raw.items))
        throw new Error("Invalid full diagnostic report");
      if (client.documentVersion(uri) !== version)
        throw new Error("Document changed during diagnostic request");
      client.setDiagnosticMode("pull");
      return classify(raw.items, false, true);
    } catch (error) {
      if (!isMethodNotFound(error)) throw error;
      client.setDiagnosticMode("push");
    }
  }
  const adapter = completedDiagnosticAdapter(client);
  if (adapter) {
    if (client.documentVersion(uri) === undefined)
      client.syncDocument(
        uri,
        content ?? (await readFile(URI.parse(uri).fsPath, "utf8")),
        languageId ?? "plaintext",
      );
    const version = client.documentVersion(uri);
    const diagnostics = await adapter.request(client, uri, signal);
    signal.throwIfAborted();
    if (client.documentVersion(uri) !== version)
      throw new Error("Document changed during diagnostic request");
    return {
      diagnostics,
      syntaxErrors: [],
      otherDiagnostics: diagnostics,
      unversioned: false,
      complete: true,
    };
  }
  signal.throwIfAborted();
  const opened = client.documentVersion(uri) !== undefined;
  const text = opened ? undefined : (content ?? (await readFile(URI.parse(uri).fsPath, "utf8")));
  signal.throwIfAborted();
  client.beginDiagnosticRequest(uri);
  try {
    return await new Promise<LspDiagnosticResult>((resolve, reject) => {
      const expectedVersion = client.documentVersion(uri) ?? 1;
      const receive = (parameters: unknown) => {
        const notification = parameters as {
          uri?: unknown;
          version?: unknown;
          diagnostics?: unknown;
        };
        if (notification.uri !== uri || !Array.isArray(notification.diagnostics)) return;
        if (notification.version !== undefined && notification.version !== expectedVersion) return;
        if (client.documentVersion(uri) !== expectedVersion) return;
        cleanup();
        resolve(
          classify(notification.diagnostics as LspDiagnostic[], notification.version === undefined),
        );
      };
      const unsubscribe = client.onNotification("textDocument/publishDiagnostics", receive);
      const onAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      function cleanup(): void {
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
      }
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (!opened) client.syncDocument(uri, text ?? "", languageId ?? "plaintext");
        const cached = client.diagnosticPublication(uri);
        if (cached) receive({ uri, ...cached });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  } finally {
    client.endDiagnosticRequest(uri);
  }
}

/** Convert protocol coordinates and severity to the shared 1-based diagnostic format. */
export function toDiagnostic(diagnostic: LspDiagnostic): Diagnostic {
  return {
    code: String(diagnostic.code ?? "LSP"),
    message: diagnostic.message,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    severity:
      diagnostic.severity === DiagnosticSeverity.Warning
        ? "warning"
        : diagnostic.severity === DiagnosticSeverity.Information
          ? "info"
          : diagnostic.severity === DiagnosticSeverity.Hint
            ? "hint"
            : "error",
  };
}

function classify(
  items: LspDiagnostic[],
  unversioned: boolean,
  complete = false,
): LspDiagnosticResult {
  const diagnostics = items.map(toDiagnostic);
  return { diagnostics, syntaxErrors: [], otherDiagnostics: diagnostics, unversioned, complete };
}

function isMethodNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === -32601;
}
