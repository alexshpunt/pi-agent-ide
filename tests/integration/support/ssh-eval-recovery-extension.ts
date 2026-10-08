import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectBeforeEditHook } from "#src/api/hooks.js";

/** Introduce one real external write after edit preparation, only in the owned eval file. */
export default async function evalRecovery(pi: ExtensionAPI): Promise<void> {
  let changed = false;
  await connectBeforeEditHook(pi, {
    id: "ssh-eval-external-writer",
    async run(event) {
      if (changed) return { decision: "allow" };
      const state = JSON.parse(await readFile(path.resolve(".pi/ssh-eval-state.json"), "utf8")) as {
        resourceRoot: string;
        physicalRoot: string;
        task: string;
      };
      if (
        state.task === "files-recovery" &&
        event.resources.some(
          (resource) => resource.resourceSource === `${state.resourceRoot}/note.ts`,
        )
      ) {
        changed = true;
        const file = path.join(state.physicalRoot, "note.ts");
        await writeFile(file, `// external café preserved\n${await readFile(file, "utf8")}`);
      }
      return { decision: "allow" };
    },
  });
}
