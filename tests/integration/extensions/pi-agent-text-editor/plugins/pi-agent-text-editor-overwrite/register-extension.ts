import registerTextEditorIntegrationExtension from "#integration/src/extensions/pi-agent-text-editor/register-extension.js";
import registerOverwriteGuard from "#pi-agent-text-editor-overwrite/index.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerOverwriteIntegrationExtension(pi: ExtensionAPI): Promise<void>
{
    await registerTextEditorIntegrationExtension(pi);
    await registerOverwriteGuard(pi);
}