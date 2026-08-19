import { copyMutationTool } from "#src/tools/tool-text-copy.js";
import { deleteMutationTool } from "#src/tools/tool-text-delete.js";
import { insertMutationTool } from "#src/tools/tool-text-insert.js";
import { moveMutationTool } from "#src/tools/tool-text-move.js";
import { replaceMutationTool } from "#src/tools/tool-text-replace.js";
import { writeMutationTool } from "#src/tools/tool-text-write.js";

import type { TextEditorCore } from "#src/core/text-editor-core.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerTextEditorTools(_pi: ExtensionAPI, core: TextEditorCore): void
{
    core.addMutationTool(writeMutationTool);
    core.addMutationTool(replaceMutationTool);
    core.addMutationTool(insertMutationTool);
    core.addMutationTool(deleteMutationTool);
    core.addMutationTool(copyMutationTool);
    core.addMutationTool(moveMutationTool);
}
