import type { FileOperationPolicy } from "pi-agent-text-editor/api/plugin-protocol";
import { prepareDeletion } from "#src/extensions/pi-agent-text-editor/src/core/delete-policy.js";
import { prepareObjectTransfer } from "#src/extensions/pi-agent-text-editor/src/core/file-transfers.js";

/** Real shared host policy for transport-only tests; no implicit approval for tracked removals. */
export const sshTransferPolicy: FileOperationPolicy = {
  prepare: (source, cwd, files) => prepareDeletion(source, cwd, { files }),
  prepareTransfer: (operation, source, target) =>
    prepareObjectTransfer(operation, source, target, {}),
};
