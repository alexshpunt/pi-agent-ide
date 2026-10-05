import { BUILTIN_EXTENSIONS } from "#src/composite/builtin-extensions.js";
import {
  readPiAgentIdeExtensionsConfig,
  resolvePiAgentIdeExtensionsConfigPaths,
} from "#src/composite/extensions-config.js";
import { AGENT_IDE_PREFERENCES } from "#src/composite/preferences.js";
import { disabledByPreset } from "#src/composite/presets.js";
import { selectBuiltinExtensions } from "#src/composite/selection.js";
import { registerModuleSettings } from "#src/composite/module-settings.js";
import { createFeatureFlags } from "#src/composite/feature-flags.js";
import { createIdeToolAvailability } from "#src/composite/tool-availability.js";
import { createNestedIdeRendering } from "#src/composite/nested-tool-rendering.js";
import { createIdeTextResults } from "#src/composite/text-results.js";

import { VERSION } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { assertSupportedHost } from "#src/composite/host-version.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
Registers the configured built-ins as one Pi Agent IDE extension.
*/
export default async function registerUnifiedPiAgentIde(pi: ExtensionAPI): Promise<void> {
  assertSupportedHost(VERSION);
  const nestedRendering = createNestedIdeRendering(pi);
  const textResults = createIdeTextResults(nestedRendering.api);
  const availability = createIdeToolAvailability(textResults.api);
  pi.on("session_start", (event, context) => {
    const restored =
      event.reason === "reload"
        ? []
        : getCurrentTools(
            context.sessionManager
              .getBranch()
              .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
          ).map((tool) => tool.name);
    availability.reconcile(true, restored);
  });
  pi.on("before_agent_start", (event) => {
    availability.reconcile();
    const systemPrompt = event.systemPrompt
      .replace(
        "- bash: Execute bash commands (ls, grep, find, etc.)",
        "- bash: Execute Bash commands",
      )
      .replace("- Use bash for file operations like ls, rg, find\n", "");
    const tools = pi.getAllTools().filter((tool) => tool.exposure !== "hidden");
    const active = pi.getActiveTools();
    const discovery = active.includes("tool_search")
      ? "Use tool_search to find"
      : active.includes("codemode")
        ? "Use searchTools inside codemode to find"
        : "Enable native tool_search to find";
    const gitTools = tools
      .filter((tool) => tool.namespace?.name === "ide_git")
      .map((tool) => tool.name);
    const guidance = [
      ...(gitTools.length === 0
        ? []
        : [
            `${discovery} ${gitTools.join(" and ")} in ide_git when staging or unstaging selected Git changes.`,
          ]),
      ...(tools.some((tool) => tool.name === "debug" && tool.namespace?.name === "ide_debug")
        ? [`${discovery} debug in ide_debug when creating a debugger session.`]
        : []),
    ];
    const prompt =
      guidance.length === 0
        ? systemPrompt
        : `${systemPrompt}\n\n<ide_discovery>\n${guidance.join("\n")}\n</ide_discovery>`;
    return prompt === event.systemPrompt ? undefined : { systemPrompt: prompt };
  });
  const config = await readPiAgentIdeExtensionsConfig(resolvePiAgentIdeExtensionsConfigPaths());
  const flags = createFeatureFlags(pi, {
    "pi-agent-ide-no-animations": config.noAnimations ?? false,
    "pi-agent-ide-no-post-processing": config.noPostProcessing ?? false,
    ...config.flags,
  });
  flags.register({
    id: "pi-agent-ide-no-animations",
    name: "Static edit previews",
    group: "ui",
    description: "Show edit results immediately, without animated playback.",
    default: false,
  });
  flags.register({
    id: "pi-agent-ide-no-post-processing",
    name: "Skip automatic post-processing",
    description:
      "Skip automatic formatting and diagnostics after edits. Explicit diagnostic reads still work.",
    default: false,
  });
  flags.register({
    id: "pi-agent-ide-vision-arbitrary-windows",
    name: "Capture arbitrary windows",
    description:
      "Allow window:PID capture for processes not owned by Agent IDE. Keep disabled unless the agent may inspect other desktop apps.",
    default: false,
  });
  flags.register({
    id: "pi-agent-ide-vision-displays",
    name: "Capture full displays",
    description:
      "Allow display screenshots through display: and display:#N resources. Keep disabled unless the agent may inspect the full desktop.",
    default: false,
  });
  flags.register({
    id: "pi-agent-ide-no-diagnostic-buffer",
    name: "Immediate diagnostic notices",
    description:
      "Send findings immediately instead of combining reports received over five seconds.",
    group: "ui",
    default: false,
  });
  flags.register({
    id: "pi-agent-ide-code-review",
    name: "Jev code review",
    description:
      "Review saved edit fragments against project YAML rules in the background. Sends code to a connected Jev provider.",
    default: false,
  });
  flags.register({
    id: "pi-agent-ide-code-review-capture",
    name: "Capture code-review rules",
    description:
      "Use the packaged skill to propose reusable rules from user review feedback. Save only after confirmation.",
    default: false,
  });
  registerModuleSettings(pi, flags.definitions, AGENT_IDE_PREFERENCES);
  const presetDisabled = disabledByPreset(BUILTIN_EXTENSIONS, config.preset ?? "full");
  const { enabled } = selectBuiltinExtensions(
    BUILTIN_EXTENSIONS,
    [...presetDisabled, ...config.disabled],
    config.enabled,
  );
  for (const extension of enabled) {
    await extension.register(availability.api, { preferences: config.preferences ?? {} });
  }
  nestedRendering.finalize();
  textResults.finalize();
}
