import { BUILTIN_EXTENSIONS } from "#src/composite/builtin-extensions.js";
import {
  readPiAgentIdeExtensionsConfig,
  resolvePiAgentIdeExtensionsConfigPaths,
} from "#src/composite/extensions-config.js";
import { selectBuiltinExtensions } from "#src/composite/selection.js";

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
  pi.registerFlag("pi-agent-ide-no-animations", {
    description: "Show IDE mutation results without animated playback",
    type: "boolean",
    default: config.noAnimations ?? false,
  });
  pi.registerFlag("pi-agent-ide-no-post-processing", {
    description:
      "Skip automatic post-edit formatting and diagnostics; explicit reads remain available",
    type: "boolean",
    default: config.noPostProcessing ?? false,
  });
  const { enabled } = selectBuiltinExtensions(BUILTIN_EXTENSIONS, config.disabled, config.enabled);

  for (const extension of enabled) {
    await extension.register(pi);
  }
}
