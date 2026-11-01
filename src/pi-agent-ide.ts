import { BUILTIN_EXTENSIONS } from "#src/composite/builtin-extensions.js";
import {
  readPiAgentIdeExtensionsConfig,
  resolvePiAgentIdeExtensionsConfigPaths,
} from "#src/composite/extensions-config.js";
import { AGENT_IDE_PREFERENCES } from "#src/composite/preferences.js";
import { disabledByPreset } from "#src/composite/presets.js";
import { selectBuiltinExtensions } from "#src/composite/selection.js";
import { registerModuleSettings } from "#src/composite/module-settings.js";
import { registerSettingsHelp } from "#src/composite/settings-help.js";
import { createFeatureFlags } from "#src/composite/feature-flags.js";
import { connectAgentDocumentation } from "#src/api/documentation.js";
import { createIdeSettingsDocumentation } from "#src/composite/settings-documentation.js";
import { createIdeToolAvailability } from "#src/composite/tool-availability.js";
import { createIdeCapabilities } from "#src/composite/capabilities.js";
import { createNestedIdeRendering } from "#src/composite/nested-tool-rendering.js";
import { createIdeTextResults } from "#src/composite/text-results.js";
import { preserveResponsesToolOmission } from "#src/composite/responses-tools.js";
import { registerOperationApproval } from "pi-agent-tool-ui/operation-approval";
import { createAgentIdeSettingsRegistry } from "#src/composite/settings-registry.js";
import { readAgentIdeSetting } from "#src/api/settings.js";
import { listenPresentationPreference } from "#src/composite/live-presentation.js";
import { createLiveFeatureFlag } from "#src/core/live-feature-flag.js";

import { VERSION } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { assertSupportedHost, hostOwnsToolLoadout } from "#src/composite/host-version.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
Registers the configured built-ins as one Pi Agent IDE extension.
*/
export default async function registerUnifiedPiAgentIde(pi: ExtensionAPI): Promise<void> {
  assertSupportedHost(VERSION);
  const config = await readPiAgentIdeExtensionsConfig(resolvePiAgentIdeExtensionsConfigPaths());
  const livePreferences: Record<string, string> = { ...config.preferences };
  for (const id of ["ui.codemode", "ui.read", "ui.search", "ui.diffs", "ui.terminal"]) {
    listenPresentationPreference(pi, id, (value) => {
      if (value === undefined) delete livePreferences[id];
      else livePreferences[id] = value;
    });
  }
  const nestedRendering = createNestedIdeRendering(
    pi,
    () => livePreferences["ui.codemode"] !== "on",
  );
  const textResults = createIdeTextResults(nestedRendering.api);
  const availability = createIdeToolAvailability(textResults.api);
  const capabilities = createIdeCapabilities(availability.api);
  // Pi can still run an in-flight request's payload hook after it disposed the session that
  // issued it. Its context is stale then, and the request is being cancelled anyway.
  let shutDown = false;
  pi.on("session_shutdown", () => {
    shutDown = true;
  });
  pi.on("before_provider_request", (event, context) => {
    if (shutDown || context.model?.api !== "openai-responses") return;
    const names = new Set(
      pi
        .getAllTools()
        .filter((tool) => tool.namespace?.name.startsWith("ide_"))
        .map((tool) => tool.name),
    );
    return preserveResponsesToolOmission(event.payload, names);
  });
  pi.on("session_start", (event, context) => {
    shutDown = false;
    // Pi 1.3 restores transcript tools and applies defaultTools and CLI +/- selections itself.
    if (hostOwnsToolLoadout(VERSION)) {
      availability.reconcile(true, [], true);
      return;
    }
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
    const options = event.systemPromptOptions;
    if (options.toolSnippets.bash)
      options.toolSnippets.bash = options.toolSnippets.bash.replace(
        "Execute bash commands (ls, grep, find, etc.)",
        "Execute Bash commands",
      );
    // Keep the legacy host-rule correction structured so portable providers can project it.
    const rules = /^<rules>\n([\s\S]*?)\n<\/rules>$/mu.exec(event.systemPrompt)?.[1];
    if (rules?.includes("- Use bash for file operations like ls, rg, find"))
      options.sections.rules = rules
        .replace(/(?:^|\n)- Use bash for file operations like ls, rg, find(?=\n|$)/u, "")
        .trim();
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
    options.sections.ide_discovery = guidance.join("\n");
  });
  const flags = createFeatureFlags(pi, {
    "pi-agent-ide-no-animations": config.noAnimations ?? false,
    "pi-agent-ide-no-post-processing": config.noPostProcessing ?? false,
    ...config.flags,
  });
  flags.register({
    id: "pi-agent-ide-developer-mode",
    name: "Developer mode",
    description: "Enable development commands, including manual setup-hint previews.",
    default: false,
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
  const settings = createAgentIdeSettingsRegistry(
    pi,
    [
      ...flags.definitions,
      {
        id: "pi-agent-ide-yolo",
        name: "YOLO: allow all operations",
        description:
          "Skip existing operation confirmation dialogs unless an extension explicitly disables its YOLO setting. Safety checks and remote permissions still apply.",
        default: false,
        labels: { on: "on", off: "off" },
      },
      {
        id: "pi-agent-ide-filesystem-yolo",
        name: "YOLO: filesystem operations",
        description:
          "Skip filesystem operation confirmations. Default inherits common YOLO; Off disables persistent permission, not remembered session grants. Protected paths stay protected.",
        default: false,
        labels: { on: "on", off: "off" },
      },
    ],
    AGENT_IDE_PREFERENCES,
  );
  registerOperationApproval(pi, {
    async isAllowed(request, context) {
      if (request.yoloSetting === undefined) return false;
      const extension = await readAgentIdeSetting(pi.events, request.yoloSetting, context.cwd);
      if (typeof extension.value !== "boolean")
        throw new Error(`Operation approval needs a boolean YOLO setting: ${request.yoloSetting}`);
      if (extension.overridden) return extension.value;
      return (
        (await readAgentIdeSetting(pi.events, "pi-agent-ide-yolo", context.cwd)).value === true
      );
    },
  });
  registerModuleSettings(pi, settings.flags, settings.preferences, config);
  registerSettingsHelp(pi);
  connectAgentDocumentation(pi, [
    createIdeSettingsDocumentation(settings.flags, settings.preferences),
  ]);
  const presetDisabled = disabledByPreset(BUILTIN_EXTENSIONS, config.preset ?? "full");
  const { enabled } = selectBuiltinExtensions(
    BUILTIN_EXTENSIONS,
    [...presetDisabled, ...config.disabled],
    config.enabled,
  );
  const staticEditPreviews = createLiveFeatureFlag(pi, "pi-agent-ide-no-animations");
  for (const extension of enabled) {
    await extension.register(capabilities.api, { preferences: livePreferences, animationsEnabled: () => !staticEditPreviews() });
  }
  capabilities.finalize(() => availability.reconcile(true, [], true));
  nestedRendering.finalize();
  textResults.finalize();
}
