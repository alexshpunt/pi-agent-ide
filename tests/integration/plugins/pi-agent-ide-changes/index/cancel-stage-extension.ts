import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { extensionGitExecutor } from "#src/plugins/pi-agent-ide-changes/src/changes/git-changes-backend.js";
import { IndexMutationQueue } from "#src/plugins/pi-agent-ide-changes/src/index-mutation-queue.js";
import { createIndexChangeTool } from "#src/plugins/pi-agent-ide-changes/src/tool-index-change.js";

/** Cancel a real Stage operation at either side of the real Git index write. */
export default function cancelStageAtIndexWrite(pi: ExtensionAPI): void {
  const git = extensionGitExecutor(pi);
  let abort: (() => void) | undefined;
  pi.on("tool_call", (event, context) => {
    if (event.toolName === "stage") abort = () => context.abort();
  });
  pi.registerTool(
    createIndexChangeTool(
      "stage",
      {
        async exec(command, arguments_, options) {
          if (arguments_[0] !== "update-index") return git.exec(command, arguments_, options);
          const phase = await readFile(path.join(options.cwd, "cancel-phase.txt"), "utf8");
          if (phase === "after") await git.exec(command, arguments_, options);
          await writeFile(path.join(options.cwd, "cancel-boundary.txt"), phase, "utf8");
          if (!abort || !options.signal) throw new Error("Stage cancellation fixture is not ready");
          abort();
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          throw new Error(`Stage fixture cancelled ${phase} the index write`);
        },
      },
      new IndexMutationQueue(),
    ),
  );
}
