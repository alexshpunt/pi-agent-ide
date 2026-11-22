import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function baseline(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, context) => {
    await writeFile(path.join(context.cwd, "baseline-prompt.txt"), event.systemPrompt);
    if (process.env.PROMPT_RULES_FORCE === "1")
      return { systemPrompt: `${event.systemPrompt}\nfixture extension guidance` };
  });
}
