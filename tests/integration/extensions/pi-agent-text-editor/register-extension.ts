import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerConstantTextAnchors from "#pi-agent-text-anchor-constant/index.js";
import registerExactTextAnchors from "#pi-agent-text-anchor-exact/index.js";
import registerLineHashTextAnchor from "#pi-agent-text-anchor-line-hash/index.js";
import { registerBuiltinEditFilter } from "#pi-agent-text-editor/core/builtin-edit-filter.js";
import registerTextEditorCore from "#pi-agent-text-editor/core/extension.js";
import { registerTextEditBatching } from "#pi-agent-text-editor/core/text-edit-batch-registrar.js";
import { registerTextEditorTools } from "#pi-agent-text-editor/tools/extension.js";

export default async function registerTextEditorIntegrationExtension(
  pi: ExtensionAPI,
): Promise<void> {
  const core = await registerTextEditorCore(pi);
  registerTextEditorTools(pi, core);
  registerTextEditBatching(pi, core);
  registerBuiltinEditFilter(pi);
  await Promise.all([
    registerLineHashTextAnchor(pi),
    registerConstantTextAnchors(pi),
    registerExactTextAnchors(pi),
  ]);
}
