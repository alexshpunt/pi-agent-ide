import { copyMutationTool } from "#src/tools/tool-text-copy.ts";
import { deleteMutationTool } from "#src/tools/tool-text-delete.ts";
import { insertMutationTool } from "#src/tools/tool-text-insert.ts";
import { moveMutationTool } from "#src/tools/tool-text-move.ts";
import { replaceMutationTool } from "#src/tools/tool-text-replace.ts";
import { writeMutationTool } from "#src/tools/tool-text-write.ts";

import type { TextEditorCore } from "#src/core/text-editor-core.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerTextEditorTools(_pi: ExtensionAPI, core: TextEditorCore): void {
  core.addMutationTool(writeMutationTool);
  core.addMutationTool(replaceMutationTool);
  core.addMutationTool(insertMutationTool);
  core.addMutationTool(deleteMutationTool);
  core.addMutationTool(copyMutationTool);
  core.addMutationTool(moveMutationTool);
}
