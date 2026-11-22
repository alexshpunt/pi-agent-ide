import type { AgentIdeProcessProvider } from "#src/plugins/pi-agent-ide-processes/src/registry.ts";
import {
  renderActiveTerminal,
  renderTerminalResult,
} from "#src/plugins/pi-agent-ide-terminal/src/renderer.ts";
import type { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.ts";

/** Expose active PTY sessions through the shared Agent IDE process registry. */
export function terminalProcessProvider(manager: TerminalSessionManager): AgentIdeProcessProvider {
  return {
    id: "terminal",
    compactionGuidance:
      "Read shell: to list every terminal session of this Pi session, including finished ones.",
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
            ...(snapshot.origin === undefined ? {} : { sessionId: snapshot.origin.sessionId }),
            status: snapshot.status === "stopping" ? ("stopping" as const) : ("running" as const),
            ...(snapshot.pid === undefined ? {} : { pid: snapshot.pid, owned: true }),
            ...(snapshot.remote === undefined ? {} : { remote: snapshot.remote, owned: true }),
            renderSummary: (theme) => renderActiveTerminal(snapshot, theme).split("\n"),
            renderDetail: (theme) => renderTerminalResult(snapshot, true, theme),
            sendInput: (data) => {
              // Manager publishes remote input failures on the session.
              void Promise.resolve(manager.write(snapshot.source, data)).catch(() => {});
            },
            stop: () => manager.delete(snapshot.source),
          };
        }),
  };
}
