import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerIdeCapability } from "#src/api/capabilities.js";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";
import {
  forgetReloadResource,
  retainReloadResource,
  takeReloadResource,
} from "#src/core/reload-resource-store.js";
import { agentIdeProcessRegistry } from "#src/plugins/pi-agent-ide-processes/src/registry.js";
import { terminalProcessProvider } from "#src/plugins/pi-agent-ide-terminal/src/process-provider.js";
import { registerTerminalResources } from "#src/plugins/pi-agent-ide-terminal/src/resources.js";
import { registerTerminalSearch } from "#src/plugins/pi-agent-ide-terminal/src/search.js";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import { observeQueuedSteering } from "#src/plugins/pi-agent-ide-terminal/src/steering.js";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";
import { registerTerminalTools } from "#src/plugins/pi-agent-ide-terminal/src/tools.js";
import { TerminalUi } from "#src/plugins/pi-agent-ide-terminal/src/ui.js";
import { registerTerminalOrigins } from "#src/plugins/pi-agent-ide-terminal/src/origin.js";
import { toolPresentation } from "#src/composite/presentation.js";
import type { BuiltinExtensionContext } from "#src/composite/selection.js";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.js";
import { readSshTargets, resolveSshConfigPaths } from "#src/backend/config.js";
import { SshBackendRegistry } from "#src/backend/registry.js";

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
        ...["read", "write", "insert", "delete"].map((tool) => ({
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

  await Promise.all([registerTerminalResources(pi, manager), registerTerminalSearch(pi, manager)]);
  const releaseForegroundWaits = registerTerminalTools(
    pi,
    manager,
    profile,
    ui,
    toolPresentation(context?.preferences["ui.terminal"]),
    targets,
    registerTerminalOrigins(pi),
  );

  const editingGuideline =
    "For shell:<session> resources, write sends exact terminal input, insert sends named keys at end, and delete terminates and removes the session. replace is unsupported.";
  registerIdeCapability(pi, {
    version: 1,
    id: "terminal",
    tools: ["bash", "powershell"],
    schemas: {
      read: {
        parameters: {
          path: "shell:<session> — status and output tail.",
          views:
            "On shell:<session>: image[:scale=S] — screen image; sequence[:duration=D,interval=I,scale=S] — frames over time, up to 10 s and 20 frames.",
        },
      },
      search: {
        promptGuidelines: [
          "path shell:<session> searches the retained text output of that terminal, including rows outside its current screen.",
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
