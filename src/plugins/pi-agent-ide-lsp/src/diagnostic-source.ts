import { requestDiagnostics, type LspDiagnosticResult } from "./lsp/diagnostics.js";
import { completedDiagnosticAdapter } from "./lsp/diagnostic-adapters.js";
import type { LspManager } from "./lsp/manager.js";
import type { IdeDiagnosticReport, IdeDiagnosticSource } from "pi-agent-ide/api/plugin-protocol";

/** Bind complete requests or explicitly incomplete push snapshots to the current file revision. */
export function createLspDiagnosticSource(
  managerFor: (
    cwd: string,
    external?: boolean,
  ) => Promise<Pick<LspManager, "getOrStart" | "languageId" | "onPushDiagnostics">>,
  resolveProject: (
    filePath: string,
    cwd: string,
  ) => Promise<{ readonly cwd: string; readonly external: boolean } | undefined> = (
    filePath,
    cwd,
  ) => Promise.resolve({ cwd, external: false }),
): IdeDiagnosticSource {
  return {
    id: "lsp",
    async diagnose(filePath, context) {
      const project = await resolveProject(filePath, context.cwd);
      if (project === undefined)
        return {
          status: "unavailable",
          diagnostics: [],
          reason: "No local language-server project found for this file",
        };
      const manager = await managerFor(project.cwd, project.external);
      context.signal.throwIfAborted();
      const client = await manager.getOrStart(filePath, project.cwd, "diagnostics");
      context.signal.throwIfAborted();
      if (!client)
        return {
          status: "unavailable",
          diagnostics: [],
          reason: "No language server configured for this file",
        };
      const uri = client.toUri(filePath);
      const languageId = manager.languageId(filePath);
      client.syncDocument(uri, context.content, languageId, true);
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
            if (current()) context.publish(toReport(result, client.commandName));
          }
        } catch (error) {
          if (current())
            context.publish({
              status: "unavailable",
              diagnostics: [],
              reason: error instanceof Error ? error.message : String(error),
              source: client.commandName,
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
          event.cwd !== project.cwd ||
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
            source: client.commandName,
            reason: snapshotReason(event.version === undefined),
          });
        }
      });
      context.signal.addEventListener("abort", unsubscribe, { once: true });
      try {
        const result = await request();
        version = client.documentVersion(uri);
        return toReport(result, client.commandName);
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

function toReport(result: LspDiagnosticResult, source: string): IdeDiagnosticReport {
  return result.complete
    ? { status: "ready", diagnostics: result.diagnostics, source }
    : {
        status: "snapshot",
        diagnostics: result.diagnostics,
        reason: snapshotReason(result.unversioned),
        source,
      };
}
