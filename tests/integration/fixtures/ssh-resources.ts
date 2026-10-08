import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectBeforeEditHook } from "pi-agent-ide/api/hooks";


/** Real-Pi SSH fixture. The external write bypasses IDE state after edit preparation. */
export default async function (pi: ExtensionAPI): Promise<void> {
  const workspace = process.env.IDE_SSH_FIXTURE_WORKSPACE;
  if (!workspace) throw new Error("Missing SSH fixture environment");
  const conflictSource = `ssh://fixture${workspace}/conflict.txt`;
  connectBeforeEditHook(pi, {
    id: "ssh-fixture-external-change",
    async run(event) {
      if (event.resources.some((resource) => resource.resourceSource === conflictSource))
        await writeFile(path.join(workspace, "conflict.txt"), "external\n");
      return { decision: "allow" };
    },
  });
}
