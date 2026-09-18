import type { AgentIdeProcessProvider } from "#src/plugins/pi-agent-ide-processes/src/registry.js";
import {
  renderActiveDebugger,
  renderDebugResult,
} from "#src/plugins/pi-agent-ide-debugger/src/renderer.js";
import type { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

/** Expose active DAP sessions through the shared Agent IDE process registry. */
export function debuggerProcessProvider(manager: DebugSessionManager): AgentIdeProcessProvider {
  return {
    id: "debugger",
    onDidChange: (listener) => manager.onDidChange(listener),
    list: () =>
      manager
        .list()
        .map((session) => manager.snapshot(session))
        .filter(
          (snapshot) =>
            snapshot.status === "configured" ||
            snapshot.status === "running" ||
            snapshot.status === "stopped",
        )
        .map((snapshot) => ({
          source: snapshot.source,
          kind: "debugger",
          title: snapshot.options.adapter,
          description: snapshot.options.program,
          status:
            snapshot.status === "configured"
              ? ("configured" as const)
              : snapshot.status === "stopped"
                ? ("paused" as const)
                : ("running" as const),
          renderSummary: (theme) => renderActiveDebugger(snapshot, theme),
          renderDetail: (theme) => renderDebugResult(snapshot, true, theme),
          stop: () => manager.delete(snapshot.source),
        })),
  };
}
