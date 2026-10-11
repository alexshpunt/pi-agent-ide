import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import registerIde from "#src/pi-agent-ide.js";

/** Inspect the real preview command without resetting its one-time startup claim. */
export default async function setupHintPreviewProbe(pi: ExtensionAPI): Promise<void> {
  let handler: RegisteredCommand["handler"] | undefined;
  await registerIde({
    ...pi,
    registerCommand(name, command) {
      if (name === "agent-ide-tip") handler = command.handler;
      pi.registerCommand(name, command);
    },
  });
  let requests = 0;
  pi.on("before_provider_request", () => { requests++; });
  pi.registerCommand("inspect-setup-hint", {
    description: "Inspect startup-tip preview effects",
    async handler(_args, ctx) {
      const output = process.env.IDE_SETUP_PREVIEW_RESULT;
      const agent = process.env.PI_CODING_AGENT_DIR;
      if (!output || !agent) throw new Error("Missing preview fixture paths");
      const state = path.join(agent, "pi-agent-ide/tips.json");
      const before = await readFile(state, "utf8");
      const entries = ctx.sessionManager.getBranch().length;
      if (handler) await handler("", ctx);
      await writeFile(output, JSON.stringify({
        registered: handler !== undefined,
        stateUnchanged: before === await readFile(state, "utf8"),
        added: ctx.sessionManager.getBranch().length - entries,
        requests,
      }));
      pi.sendUserMessage("Inspection complete");
    },
  });
}
