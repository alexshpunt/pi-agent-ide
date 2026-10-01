import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";

import { hideBuiltinEdit } from "./src/core/builtin-edit.js";
import registerTextEditorCore from "./src/core/extension.js";
import { registerTextEditBatching } from "./src/core/text-edit-batch-registrar.js";
import { registerNativeTextEditBatching } from "./src/core/native-text-edit-batch.js";
import { registerTextEditorTools } from "./src/tools/extension.js";

export default async function registerTextEditor(pi: ExtensionAPI): Promise<void> {
  connectAgentDocumentation(pi, [
    await loadPackagedAgentGuide({
      id: "apply",
      description: "Guarded Apply scripting, selections, transactions, and file operations",
      triggers: [{ tool: "apply" }],
    }),
    await loadPackagedAgentGuide({
      id: "editing",
      description: "Precise standalone text and file edits",
      triggers: ["write", "replace", "insert", "delete", "copy", "move", "diff"].map((tool) => ({
        tool,
      })),
    }),
  ]);
  const core = await registerTextEditorCore(pi);
  hideBuiltinEdit(pi);

  registerTextEditorTools(pi, core);

  registerTextEditBatching(pi, core);
  registerNativeTextEditBatching(pi, core);
}
