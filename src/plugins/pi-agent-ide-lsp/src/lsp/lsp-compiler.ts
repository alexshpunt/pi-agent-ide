import { requestDiagnostics } from "./diagnostics.js";

import type { LspClient } from "./client.js";
import type { LspManager } from "./manager.js";
import type { Compiler, Diagnostic, ToolContext } from "pi-agent-ide/api/toolchain";

/**
 * Compile with the language server selected for the actual source owner.
 * Missing diagnostics support is a refusal, not a clean result.
 * LSP type errors never act as a syntax-only formatting gate.
 */
export function createLspCompiler(
  managerForFile: (
    cwd: string,
    filePath: string,
    signal?: AbortSignal,
  ) => Promise<Pick<LspManager, "openFile">>,
): Compiler {
  let _client: LspClient | null = null;

  return {
    kind: "compiler",
    name: "lsp",
    priority: 100,
    extensions: ["*"],
    detect: () => Promise.resolve(true),
    async compile({ filePath }, context) {
      context.signal?.throwIfAborted();
      const manager = await managerForFile(context.cwd, filePath, context.signal);
      context.signal?.throwIfAborted();
      const result = await openAndDiagnose(filePath, context, manager);

      if (!result) {
        throw new Error("No diagnostic language server for this source");
      }

      const { client, diagnostics, syntaxErrors, otherDiagnostics } = result;
      _client = client;

      return {
        ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
        diagnostics,
        syntaxErrors,
        otherDiagnostics,
      };
    },
    async restart() {
      if (!_client) {
        return;
      }

      await _client.restart();
      _client = null;
    },
  };
}

// ── shared helpers ───────────────────────────────────────────────────

async function openAndDiagnose(
  filePath: string,
  context: ToolContext,
  manager: Pick<LspManager, "openFile">,
): Promise<{
  client: LspClient;
  diagnostics: Diagnostic[];
  syntaxErrors: Diagnostic[];
  otherDiagnostics: Diagnostic[];
} | null> {
  const opened = await manager.openFile(filePath, context.cwd, "diagnostics", context.signal);
  context.signal?.throwIfAborted();

  if (!opened) {
    return null;
  }

  const diag = await requestDiagnostics(opened.client, opened.uri, opened.languageId, {
    signal: context.signal,
  });
  context.signal?.throwIfAborted();
  if (!diag.complete)
    throw new Error("Language server diagnostics are a snapshot, not a completed report");
  return { client: opened.client, ...diag };
}
