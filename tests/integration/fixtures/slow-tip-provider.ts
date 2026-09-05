import { writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";

import { waitForTip } from "#integration/support/wait-for-tip.ts";
import { connectTipProvider, TIP_API_VERSION, TIP_PROTOCOL, type Tip } from "pi-agent-ide/api/tips";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Holds a real tip until an agent tool releases it, making startup blocking observable. */
export default async function registerSlowTip(pi: ExtensionAPI): Promise<void> {
  let release = (_tip: Tip): void => {};
  const gate = new Promise<Tip>((resolve) => { release = resolve; });
  await connectTipProvider(pi, {
    protocol: TIP_PROTOCOL, apiVersion: TIP_API_VERSION, id: "slow-provider",
    getTip(context) {
      context.signal?.addEventListener("abort", () => {
        writeFileSync(path.join(context.cwd, "tip-aborted.txt"), "aborted");
        // A late successful result must not reach the ended session's UI or state.
        release({ id: "late", title: "Late forbidden tip", body: "Must not appear" });
      }, { once: true });
      return gate;
    },
  });
  pi.registerCommand("tips-reload", {
    description: "Reload while a test tip is pending.",
    async handler(_args, ctx) { await ctx.reload(); },
  });
  pi.on("resources_discover", (event) => {
    if (event.reason === "reload") pi.sendUserMessage("Release the new session's tip", { deliverAs: "followUp" });
  });
  pi.registerTool({
    name: "release_tip", label: "Release tip", description: "Release a pending test tip.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _onUpdate, context) {
      release({ id: "slow-tip", title: "Slow startup tip", body: "The session was ready before this inspection finished." });
      await waitForTip(context);
      return { content: [{ type: "text", text: "Tip displayed after session readiness" }], details: {} };
    },
  });
}
