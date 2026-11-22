import { appendFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EDIT_WAIT_TIMEOUT_MS } from "pi-agent-resource";
import {
  connectTextEditorPlugin,
  connectTextEditorPostEditHandler,
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-ide/api/text-editor";

/** Keep the first standalone edit's reservation past the short acquisition limit. */
export default async function slowFirstEdit(pi: ExtensionAPI): Promise<void> {
  connectTextEditorPostEditHandler(pi, {
    id: "slow-first-edit",
    async handler({ cwd, resourceSource, requestedAfter, signal }) {
      if (path.basename(resourceSource) !== "parallel.txt") return;
      const saved = (requestedAfter.content.match(/\[new /gu) ?? []).length;
      if (saved === 1) await setTimeout(EDIT_WAIT_TIMEOUT_MS + 1_000, undefined, { signal });
      await appendFile(path.join(cwd, "saved-edits.txt"), `${saved}\n`);
    },
  });
  await connectTextEditorPlugin(pi, {
    id: "standalone-replace",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      // A matching pre-edit planner makes Pi use the standalone path for every call.
      api.tool("replace").addHandler({
        stage: "text-pre-edit",
        when: (input) => typeof input === "object" && input !== null && "path" in input &&
          input.path === "parallel.txt",
        handler: (state) => state,
      });
    },
  });
}
