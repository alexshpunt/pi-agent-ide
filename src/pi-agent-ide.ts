import { BUILTIN_EXTENSIONS } from "#src/composite/builtin-extensions.ts";
import {
  configuredFeatureFlags,
  readPiAgentIdeExtensionsConfig,
  resolvePiAgentIdeExtensionsConfigPaths,
} from "#src/composite/extensions-config.ts";
import { AGENT_IDE_PREFERENCES } from "#src/composite/preferences.ts";
import { disabledByPreset } from "#src/composite/presets.ts";
import { selectBuiltinExtensions } from "#src/composite/selection.ts";
import { registerModuleSettings } from "#src/composite/module-settings.ts";
import { registerSettingsHelp } from "#src/composite/settings-help.ts";
import { createFeatureFlags } from "#src/composite/feature-flags.ts";
import { connectAgentDocumentation } from "#src/api/documentation.ts";
import { createIdeSettingsDocumentation } from "#src/composite/settings-documentation.ts";
import { createIdeToolAvailability } from "#src/composite/tool-availability.ts";
import {
  buildIdeDiscoveryGuidance,
  explainCodemodeDiscoveryError,
} from "#src/composite/tool-discovery-guidance.ts";
import { buildParallelToolGuidance } from "#src/composite/parallel-tool-guidance.ts";
import { createIdeCapabilities } from "#src/composite/capabilities.ts";
import { createNestedIdeRendering } from "#src/composite/nested-tool-rendering.ts";
import { createIdeTextResults } from "#src/composite/text-results.ts";
import { registerDetachedResults } from "#src/composite/detached-results.ts";
import { preserveResponsesToolOmission } from "#src/composite/responses-tools.ts";
import { explainCodemodeToolNames } from "#src/composite/codemode-tool-names.ts";
import { registerOperationApproval } from "pi-agent-tool-ui/operation-approval";
import { createAgentIdeSettingsRegistry } from "#src/composite/settings-registry.ts";
import { readAgentIdeSetting } from "#src/api/settings.ts";
import { listenPresentationPreference } from "#src/composite/live-presentation.ts";
import { createLiveFeatureFlag, IDE_FEATURE_FLAGS_CHANGED } from "#src/core/live-feature-flag.ts";
import { createIdeProblemReports, PROBLEM_REPORTS_FLAG } from "#src/composite/problem-reports.ts";
import { saveModuleChoices } from "#src/composite/module-settings-store.ts";
import { registerBuiltinModules } from "#src/composite/module-registration.ts";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { assertSupportedHost, hostOwnsToolLoadout } from "#src/composite/host-version.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
Registers the configured built-ins as one Pi Agent IDE extension.
*/
export default async function registerUnifiedPiAgentIde(host: ExtensionAPI): Promise<void> {
  assertSupportedHost(VERSION);
  const configPaths = resolvePiAgentIdeExtensionsConfigPaths();
  const config = await readPiAgentIdeExtensionsConfig(configPaths);
  let problemReportsEnabled = () => true;
  const problems = createIdeProblemReports(host, {
    enabled: () => problemReportsEnabled(),
    async disable() {
      await saveModuleChoices(
        configPaths.globalPath,
        new Map(),
        new Map([[PROBLEM_REPORTS_FLAG, false]]),
      );
      const effective = await readPiAgentIdeExtensionsConfig(configPaths);
      host.events.emit(IDE_FEATURE_FLAGS_CHANGED, { flags: configuredFeatureFlags(effective) });
    },
  });
  // Every hook registered below reports internal errors instead of ending Pi from a frame.
  const pi = problems.guard(host, { id: "core" });
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
    if (shutDown) return;
    const api: unknown = context.model?.api;
    const registered = pi.getAllTools();
    const names = new Set(
      registered
        .filter((tool) => tool.namespace?.name.startsWith("ide_") && tool.exposure !== "hidden")
        .map((tool) => tool.name),
    );
    const payload =
      api === "openai-responses"
        ? preserveResponsesToolOmission(event.payload, names)
        : event.payload;
    return explainCodemodeToolNames(
      payload,
      names,
      registered.some((tool) => tool.name === "tool_search" && tool.exposure === "model-only"),
    );
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
  pi.on("before_agent_start", (event, context) => {
    availability.reconcile();
    const options = event.systemPromptOptions;
    if (options.toolSnippets.bash)
      options.toolSnippets.bash = options.toolSnippets.bash.replace(
        "Execute bash commands (ls, grep, find, etc.)",
        "Execute Bash commands",
      );
    // A prior extension can force the complete prompt, making section overrides ineffective.
    const rules = /^<rules>\n([\s\S]*?)\n<\/rules>$/mu.exec(event.systemPrompt)?.[1];
    const bashRule = /(?:^|\n)- Use bash for file operations like ls, rg, find(?=\n|$)/u;
    if (rules && bashRule.test(rules)) {
      const corrected = rules.replace(bashRule, "").replace(/^\n/u, "");
      if (options.forceSystemPrompt !== undefined) {
        options.forceSystemPrompt = options.forceSystemPrompt.replace(
          `<rules>\n${rules}\n</rules>`,
          `<rules>\n${corrected}\n</rules>`,
        );
      } else {
        options.sections.rules = corrected;
      }
    }
    options.sections.parallel_tool_calls = buildParallelToolGuidance(context.model?.api);
    options.sections.ide_discovery = buildIdeDiscoveryGuidance(
      pi.getAllTools(),
      pi.getActiveTools(),
      pi.getSettings().codemode?.mode === "only",
    );
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
  flags.register({
    id: PROBLEM_REPORTS_FLAG,
    name: "Problem reports",
    description:
      "After an internal Pi Agent IDE error, offer a prefilled GitHub issue above the editor. Nothing is sent until you submit it.",
    group: "ui",
    default: true,
  });
  problemReportsEnabled = createLiveFeatureFlag(pi, PROBLEM_REPORTS_FLAG, true);
  const stopProblemRefresh = pi.events.on(IDE_FEATURE_FLAGS_CHANGED, () => {
    // The live flag reads the same event; refresh after it has.
    queueMicrotask(() => problems.reporter.refresh());
  });
  pi.on("session_shutdown", stopProblemRefresh);
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
  // One module that fails to register must not take the others down with it.
  await registerBuiltinModules(
    enabled,
    capabilities.api,
    { preferences: livePreferences, animationsEnabled: () => !staticEditPreviews() },
    problems,
  );
  capabilities.finalize(() => availability.reconcile(true, [], true));
  nestedRendering.finalize();
  pi.on("tool_result", explainCodemodeDiscoveryError);
  textResults.finalize();
  registerDetachedResults(pi);
}
