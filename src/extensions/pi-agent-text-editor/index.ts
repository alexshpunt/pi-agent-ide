import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerBuiltinEditFilter } from "./src/core/builtin-edit-filter.js";
import registerTextEditorCore from "./src/core/extension.js";
import { registerTextEditBatching } from "./src/core/text-edit-batch-registrar.js";
import { registerTextEditorTools } from "./src/tools/extension.js";

export default async function registerTextEditor(pi: ExtensionAPI): Promise<void>
{
    const core = await registerTextEditorCore(pi);
    registerBuiltinEditFilter(pi);

    if (!process.argv.includes("--old-tools"))
    {
        registerTextEditorTools(pi, core);
    }

    registerTextEditBatching(pi, core);
}
