import type { AgentIdeProcessProvider } from "#src/plugins/pi-agent-ide-processes/src/registry.js";
import {
  renderActiveTerminal,
  renderTerminalResult,
} from "#src/plugins/pi-agent-ide-terminal/src/renderer.js";
import type { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";

/** Expose active PTY sessions through the shared Agent IDE process registry. */
export function terminalProcessProvider(manager: TerminalSessionManager): AgentIdeProcessProvider {
  return {
    id: "terminal",
    onDidChange: (listener) => manager.onDidChange(listener),
    list: () =>
      manager
        .list()
        .filter((session) => session.status === "running" || session.status === "stopping")
        .map((snapshot) => {
          return {
            source: snapshot.source,
            kind: "terminal",
            title: snapshot.shell.toLocaleLowerCase(),
            description: snapshot.command,
            status: snapshot.status === "stopping" ? ("stopping" as const) : ("running" as const),
            renderSummary: (theme) => renderActiveTerminal(snapshot, theme).split("\n"),
            renderDetail: (theme) => renderTerminalResult(snapshot, true, theme),
            stop: () => manager.delete(snapshot.source),
          };
        }),
  };
}
