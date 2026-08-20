import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerTextEditorIntegrationExtension from "#integration/extensions/pi-agent-text-editor/register-extension.js";
import registerOverwriteGuard from "#pi-agent-text-editor-overwrite/index.js";

export default async function registerOverwriteIntegrationExtension(
  pi: ExtensionAPI,
): Promise<void> {
  await registerTextEditorIntegrationExtension(pi);
  await registerOverwriteGuard(pi);
}
