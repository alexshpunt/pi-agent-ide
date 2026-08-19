import { BUILTIN_EXTENSIONS } from "#src/composite/builtin-extensions.js";
import { selectBuiltinExtensions } from "#src/composite/selection.js";
import { readPiAgentIdeConfig, resolvePiAgentIdeConfigPath } from "#src/composite/config.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Registers the configured built-ins as one Pi Agent IDE extension. */
export default async function registerUnifiedPiAgentIde(pi: ExtensionAPI): Promise<void>
{
    const config = await readPiAgentIdeConfig(resolvePiAgentIdeConfigPath());
    const { enabled } = selectBuiltinExtensions(BUILTIN_EXTENSIONS, config.disabledExtensions);

    for (const extension of enabled)
    {
        await extension.register(pi);
    }
}
