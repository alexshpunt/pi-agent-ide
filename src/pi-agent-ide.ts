import { BUILTIN_EXTENSIONS } from "#src/composite/builtin-extensions.js";
import {
  readPiAgentIdeExtensionsConfig,
  resolvePiAgentIdeExtensionsConfigPaths,
} from "#src/composite/extensions-config.js";
import { selectBuiltinExtensions } from "#src/composite/selection.js";
import { registerModuleSettings } from "#src/composite/module-settings.js";
import { createFeatureFlags } from "#src/composite/feature-flags.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
Registers the configured built-ins as one Pi Agent IDE extension.
*/
export default async function registerUnifiedPiAgentIde(pi: ExtensionAPI): Promise<void> {
  pi.on("before_agent_start", (event) => {
    const systemPrompt = event.systemPrompt
      .replace(
        "- bash: Execute bash commands (ls, grep, find, etc.)",
        "- bash: Execute Bash commands",
      )
      .replace("- Use bash for file operations like ls, rg, find\n", "");
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
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
    id: "pi-agent-ide-no-apply",
    name: "Disable Apply",
    description: "Hide the Apply tool. Standalone read, search and editing tools remain available.",
    default: false,
  });
  flags.register({
    id: "pi-agent-ide-apply-code",
    name: "Apply presentation",
    description:
      "Mixed compacts written tool calls during streaming. Code shows the full script. Expanded always exposes the source.",
    group: "ui",
    labels: { on: "Code", off: "Mixed" },
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
  registerModuleSettings(pi, flags.definitions);
  const { enabled } = selectBuiltinExtensions(BUILTIN_EXTENSIONS, config.disabled, config.enabled);

  for (const extension of enabled) {
    await extension.register(pi);
  }
}
