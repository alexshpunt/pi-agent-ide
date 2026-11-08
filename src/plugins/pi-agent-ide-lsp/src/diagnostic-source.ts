import { requestDiagnostics, type LspDiagnosticResult } from "./lsp/diagnostics.js";
import { completedDiagnosticAdapter } from "./lsp/diagnostic-adapters.js";
import type { LspManager } from "./lsp/manager.js";
import type { IdeDiagnosticReport, IdeDiagnosticSource } from "pi-agent-ide/api/plugin-protocol";

/** Bind complete requests or explicitly incomplete push snapshots to the current file revision. */
export function createLspDiagnosticSource(
  managerFor: (
    cwd: string,
    external?: boolean,
    signal?: AbortSignal,
  ) => Promise<Pick<LspManager, "getOrStart" | "languageId" | "onPushDiagnostics">>,
  resolveProject: (
    filePath: string,
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<{ readonly cwd: string; readonly external: boolean } | undefined> = (
    filePath,
    cwd,
  ) => Promise.resolve({ cwd, external: false }),
): IdeDiagnosticSource {
  return {
    id: "lsp",
    async diagnose(filePath, context) {
      const project = await resolveProject(filePath, context.cwd, context.signal);
      if (project === undefined)
        return {
          status: "unavailable",
          diagnostics: [],
          reason: "No local language-server project found for this file",
        };
      const manager = await managerFor(project.cwd, project.external, context.signal);
      context.signal.throwIfAborted();
      const client = await manager.getOrStart(filePath, project.cwd, "diagnostics", context.signal);
      context.signal.throwIfAborted();
      if (!client)
        return {
          status: "unavailable",
          diagnostics: [],
          reason: "No language server configured for this file",
        };
      const uri = client.toUri(filePath);
      const languageId = manager.languageId(filePath);
      // Close the document after the report unless another operation uses it. Later pushes and
      // refreshes apply only while the reported version stays open.
      const release = client.retainDocument(uri);
      try {
        client.syncDocument(uri, context.content, languageId, true);
      } catch (error) {
        release();
        throw error;
      }
      let version = client.documentVersion(uri);
      const refreshState = { active: true, queued: false };
      const current = () => !context.signal.aborted && client.documentVersion(uri) === version;
      const request = async () => {
        // A server that is still loading the project reports no diagnostics yet.
        await client.waitUntilLoaded(context.signal);
        return requestDiagnostics(client, uri, languageId, {
          signal: context.signal,
          content: context.content,
        });
      };
      // Servers send refreshes and pushes in bursts while files change, and each pull of a
      // changed project can make the server check the file again. Pull once the triggers pause,
      // or after REFRESH_MAX_WAIT_MS when they keep coming.
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      let firstTrigger: number | undefined;
      const pullAgain = async () => {
        refreshTimer = undefined;
        firstTrigger = undefined;
        if (refreshState.active || !refreshState.queued || !current()) return;
        refreshState.active = true;
        refreshState.queued = false;
        try {
          const result = await request();
          if (current()) context.publish(toReport(result, client.commandName));
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
          // A trigger may have arrived during the pull.
          schedule();
        }
      };
      const schedule = () => {
        if (refreshState.active || !refreshState.queued || !current()) return;
        const now = Date.now();
        firstTrigger ??= now;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(
          () => void pullAgain(),
          Math.max(0, Math.min(REFRESH_QUIET_MS, firstTrigger + REFRESH_MAX_WAIT_MS - now)),
        );
      };
      const refresh = () => {
        refreshState.queued = true;
        schedule();
      };
      // A pull server asks for a new pull when results change, such as after other files changed.
      const unsubscribeRefresh = client.onNotification("workspace/diagnostic/refresh", () => {
        if (current() && client.diagnosticMode === "pull") refresh();
      });
      const unsubscribePush = manager.onPushDiagnostics((event) => {
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
          refresh();
        } else {
          context.publish({
            status: "snapshot",
            diagnostics: event.diagnostics,
            source: client.commandName,
            reason: snapshotReason(event.version === undefined),
          });
        }
      });
      const unsubscribe = () => {
        clearTimeout(refreshTimer);
        unsubscribePush();
        unsubscribeRefresh();
      };
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
        release();
        refreshState.active = false;
        schedule();
      }
    },
  };
}

/** Quiet time after the last refresh or push before diagnostics are pulled again. */
const REFRESH_QUIET_MS = 750;
/** Longest delay of a repeated pull while triggers keep arriving. */
const REFRESH_MAX_WAIT_MS = 3000;

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
