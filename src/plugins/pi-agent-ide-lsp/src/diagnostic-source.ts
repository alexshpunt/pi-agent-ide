import path from "node:path";

import { requestDiagnostics, type LspDiagnosticResult } from "./lsp/diagnostics.js";
import { completedDiagnosticAdapter } from "./lsp/diagnostic-adapters.js";
import type { LspManager } from "./lsp/manager.js";
import type { IdeDiagnosticReport, IdeDiagnosticSource } from "pi-agent-ide/api/plugin-protocol";

/** Bind complete requests or explicitly incomplete push snapshots to the current file revision. */
export function createLspDiagnosticSource(
  managerFor: (
    cwd: string,
  ) => Promise<Pick<LspManager, "getOrStart" | "languageId" | "onPushDiagnostics">>,
): IdeDiagnosticSource {
  return {
    id: "lsp",
    async diagnose(filePath, context) {
      const manager = await managerFor(context.cwd);
      context.signal.throwIfAborted();
      const extension = path.extname(filePath).toLowerCase();
      const client = await manager.getOrStart(extension, context.cwd, "diagnostics");
      context.signal.throwIfAborted();
      if (!client)
        return {
          status: "unavailable",
          diagnostics: [],
          reason: "No language server configured for this file",
        };
      const uri = client.toUri(filePath);
      const languageId = manager.languageId(extension);
      client.syncDocument(uri, context.content, languageId);
      let version = client.documentVersion(uri);
      const refreshState = { active: true, queued: false };
      const current = () => !context.signal.aborted && client.documentVersion(uri) === version;
      const request = () =>
        requestDiagnostics(client, uri, languageId, {
          signal: context.signal,
          content: context.content,
        });
      const refresh = async () => {
        refreshState.queued = true;
        if (refreshState.active) return;
        refreshState.active = true;
        try {
          while (refreshState.queued && current()) {
            refreshState.queued = false;
            const result = await request();
            if (current()) context.publish(toReport(result));
          }
        } catch (error) {
          if (current())
            context.publish({
              status: "unavailable",
              diagnostics: [],
              reason: error instanceof Error ? error.message : String(error),
            });
        } finally {
          refreshState.active = false;
        }
      };
      const unsubscribe = manager.onPushDiagnostics((event) => {
        if (
          !current() ||
          event.uri !== uri ||
          event.serverId !== client.serverId ||
          event.cwd !== context.cwd ||
          (event.version !== undefined && event.version !== version)
        )
          return;
        if (client.diagnosticMode === "pull" || completedDiagnosticAdapter(client)) {
          // Push notifications are invalidations, not complete reports. Requery without resending didChange.
          void refresh();
        } else {
          context.publish({
            status: "snapshot",
            diagnostics: event.diagnostics,
            reason: snapshotReason(event.version === undefined),
          });
        }
      });
      context.signal.addEventListener("abort", unsubscribe, { once: true });
      try {
        const result = await request();
        version = client.documentVersion(uri);
        return toReport(result);
      } catch (error) {
        refreshState.queued = false;
        unsubscribe();
        context.signal.removeEventListener("abort", unsubscribe);
        throw error;
      } finally {
        refreshState.active = false;
        if (refreshState.queued && current())
          queueMicrotask(() => {
            void refresh();
          });
      }
    },
  };
}

function snapshotReason(unversioned: boolean): string {
  return `Latest push snapshot; completion is unknown${unversioned ? "; language server omitted the document version" : ""}`;
}

function toReport(result: LspDiagnosticResult): IdeDiagnosticReport {
  return result.complete
    ? { status: "ready", diagnostics: result.diagnostics }
    : {
        status: "snapshot",
        diagnostics: result.diagnostics,
        reason: snapshotReason(result.unversioned),
      };
}
