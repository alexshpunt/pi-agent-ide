import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerConstantTextAnchors from "#pi-agent-text-anchor-constant/index.ts";
import registerExactTextAnchors from "#pi-agent-text-anchor-exact/index.ts";
import registerLineHashTextAnchor from "#pi-agent-text-anchor-line-hash/index.ts";
import { hideBuiltinEdit } from "#pi-agent-text-editor/core/builtin-edit.ts";
import registerTextEditorCore from "#pi-agent-text-editor/core/extension.ts";
import { registerTextEditBatching } from "#pi-agent-text-editor/core/text-edit-batch-registrar.ts";
import { registerTextEditorTools } from "#pi-agent-text-editor/tools/extension.ts";

export default async function registerTextEditorIntegrationExtension(
  pi: ExtensionAPI,
): Promise<void> {
  const core = await registerTextEditorCore(pi);
  registerTextEditorTools(pi, core);
  registerTextEditBatching(pi, core);
  hideBuiltinEdit(pi);
  await Promise.all([
    registerLineHashTextAnchor(pi),
    registerConstantTextAnchors(pi),
    registerExactTextAnchors(pi),
  ]);
}
