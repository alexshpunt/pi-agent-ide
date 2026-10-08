import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerIde from "#src/pi-agent-ide.js";

/** Record the actual IDE registry so a new tool cannot silently miss the budget matrix. */
export default async function outputBudgetIde(pi: ExtensionAPI) {
  const names = new Set<string>();
  await registerIde({
    ...pi,
    registerTool(definition) {
      if (definition.exposure !== "hidden") names.add(definition.name);
      pi.registerTool(definition);
    },
  });
  pi.on("session_start", async (_event, context) => {
    await writeFile(path.join(context.cwd, "ide-tools.json"), JSON.stringify([...names].sort()));
  });
}
