import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectBeforeEditHook } from "pi-agent-ide/api/hooks";


/** Real-Pi SSH fixture. The external write bypasses IDE state after edit preparation. */
export default async function (pi: ExtensionAPI): Promise<void> {
  const workspace = process.env.IDE_SSH_FIXTURE_WORKSPACE;
  if (!workspace) throw new Error("Missing SSH fixture environment");
  const conflictSource = `ssh://fixture${workspace}/conflict.txt`;
  let receipt: string | undefined;
  pi.on("tool_result", (event) => {
    if (event.toolName === "apply")
      receipt = /APPLY#[0-9A-F]{12}/u.exec(JSON.stringify(event.content))?.[0];
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== "undo" || event.input === null || typeof event.input !== "object") return;
    const input = event.input as Record<string, unknown>;
    if (input.transaction !== "APPLY#000000000000") return;
    if (receipt === undefined) throw new Error("Apply did not return an undo receipt");
    input.transaction = receipt;
  });
  connectBeforeEditHook(pi, {
    id: "ssh-fixture-external-change",
    async run(event) {
      if (event.resources.some((resource) => resource.resourceSource === conflictSource))
        await writeFile(path.join(workspace, "conflict.txt"), "external\n");
      return { decision: "allow" };
    },
  });
}
