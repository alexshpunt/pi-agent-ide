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
  const { enabled } = selectBuiltinExtensions(BUILTIN_EXTENSIONS, config.disabled, config.enabled);

  for (const extension of enabled) {
    await extension.register(pi);
  }
}
