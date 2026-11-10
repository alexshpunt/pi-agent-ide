import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOperationApproval } from "pi-agent-tool-ui/operation-approval";

import { hideBuiltinEdit } from "./src/core/builtin-edit.ts";
import registerTextEditorCore from "./src/core/extension.ts";
import { registerTextEditBatching } from "./src/core/text-edit-batch-registrar.ts";
import { registerNativeTextEditBatching } from "./src/core/native-text-edit-batch.ts";
import { registerTextEditorTools } from "./src/tools/extension.ts";

export default async function registerTextEditor(pi: ExtensionAPI): Promise<void> {
  registerOperationApproval(pi);
  const core = await registerTextEditorCore(pi);
  hideBuiltinEdit(pi);

  registerTextEditorTools(pi, core);

  registerTextEditBatching(pi, core);
  registerNativeTextEditBatching(pi, core);
}
