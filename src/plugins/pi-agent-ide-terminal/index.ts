import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerIdeCapability } from "#src/api/capabilities.ts";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";
import {
  forgetReloadResource,
  retainReloadResource,
  takeReloadResource,
} from "#src/core/reload-resource-store.ts";
import { agentIdeProcessRegistry } from "#src/plugins/pi-agent-ide-processes/src/registry.ts";
import { terminalProcessProvider } from "#src/plugins/pi-agent-ide-terminal/src/process-provider.ts";
import { registerTerminalResources } from "#src/plugins/pi-agent-ide-terminal/src/resources.ts";
import { registerTerminalSearch } from "#src/plugins/pi-agent-ide-terminal/src/search.ts";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.ts";
import { observeQueuedSteering } from "#src/plugins/pi-agent-ide-terminal/src/steering.ts";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.ts";
import { registerTerminalTools } from "#src/plugins/pi-agent-ide-terminal/src/tools.ts";
import { TerminalUi } from "#src/plugins/pi-agent-ide-terminal/src/ui.ts";
import { registerTerminalOrigins } from "#src/plugins/pi-agent-ide-terminal/src/origin.ts";
import { toolPresentation } from "#src/composite/presentation.ts";
import type { BuiltinExtensionContext } from "#src/composite/selection.ts";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.ts";
import { readSshTargets, resolveSshConfigPaths } from "#src/backend/config.ts";
import { SshBackendRegistry } from "#src/backend/registry.ts";

/** Register the platform-aware terminal runner and shell session resources. */
export default async function registerTerminal(
  pi: ExtensionAPI,
  context?: BuiltinExtensionContext,
): Promise<void> {
  connectAgentDocumentation(pi, [
    await loadPackagedAgentGuide({
      id: "terminal",
      description: "Foreground and background commands, shell resources, and processes",
      triggers: [
        { tool: "bash" },
        { tool: "powershell" },
        { tool: "remote_bash" },
        { tool: "remote_powershell" },
        ...["read", "search", "write", "insert", "delete", "move"].map((tool) => ({
          tool,
          resourcePrefixes: ["shell:"],
        })),
      ],
    }),
  ]);
  const manager =
    takeReloadResource("terminal", TerminalSessionManager) ?? new TerminalSessionManager();
  const profile = resolveShellProfile();
  const targets = new SshBackendRegistry(
    await readSshTargets(resolveSshConfigPaths(resolvePiAgentIdeExtensionsConfigPaths())),
  );
  const ui = new TerminalUi(pi, manager);
  const removeProcessProvider = agentIdeProcessRegistry(pi).add(terminalProcessProvider(manager));

  // Listing and searching `shell:` cover the sessions this Pi session started.
  let ownerSessionId: string | undefined;
  const currentSessionId = (): string | undefined => ownerSessionId;
  pi.on("session_start", (_event, context) => {
    ownerSessionId = context.sessionManager.getSessionId();
  });
  await Promise.all([
    registerTerminalResources(pi, manager, currentSessionId),
    registerTerminalSearch(pi, manager, currentSessionId),
  ]);
  const presentation = () => toolPresentation(context?.preferences["ui.terminal"]);
  const releaseForegroundWaits = registerTerminalTools(
    pi,
    manager,
    profile,
    ui,
    presentation,
    targets,
    registerTerminalOrigins(pi),
  );

  const editingGuideline =
    "For shell:<session> resources, write sends exact terminal input, insert sends named keys at end, and delete terminates and removes the session. replace is unsupported.";
  registerIdeCapability(pi, {
    version: 1,
    id: "terminal",
    tools: ["bash", "powershell", "remote_bash", "remote_powershell"],
    schemas: {
      read: {
        parameters: {
          path: "shell: — terminal sessions started in this Pi session; shell:<session> — status and output tail.",
          views:
            "On shell:<session>: image[:scale=S] — screen image; sequence[:duration=D,interval=I,scale=S] — frames over time, up to 10 s and 20 frames.",
        },
      },
      search: {
        promptGuidelines: [
          "path shell:<session> searches the retained text output of that terminal, including rows outside its current screen; path shell: searches every terminal session of this Pi session.",
        ],
      },
      write: {
        parameters: {
          path: "shell:<session> types into that terminal.",
          content: "For shell:<session>, exact input; Enter is not added.",
        },
        promptGuidelines: [editingGuideline],
      },
      insert: {
        parameters: {
          path: "shell:<session> sends keys to that terminal.",
          anchor: "Omit for shell:<session>.",
          text: "For shell:<session>: named keys and chords such as Enter, Ctrl+C, Up, or caret forms such as ^C, separated by spaces or commas.",
        },
        promptGuidelines: [editingGuideline],
      },
      delete: {
        parameters: { path: "shell:<session> ends that session." },
        promptGuidelines: [editingGuideline],
      },
      move: {
        parameters: {
          path: "shell:<session> with target shell:<name> renames that terminal session.",
        },
      },
    },
  });

  let removeSteeringObserver = (): void => {};
  pi.on("session_start", (_event, context) => {
    ui.bind(context);
    removeSteeringObserver();
    removeSteeringObserver = observeQueuedSteering((session) => {
      if (session.sessionManager === context.sessionManager) releaseForegroundWaits();
    });
  });
  pi.on("agent_settled", (_event, context) => ui.onAgentSettled(context));
  pi.on("session_shutdown", async (event) => {
    removeSteeringObserver();
    ui.dispose();
    removeProcessProvider();
    if (event.reason !== "quit") {
      retainReloadResource("terminal", manager);
      return;
    }
    forgetReloadResource("terminal", manager);
    await manager.dispose();
  });
}
