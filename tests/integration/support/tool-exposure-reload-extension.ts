import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Drive a real command reload after the first agent turn, then continue the conversation. */
export default function registerToolExposureReloadFixture(pi: ExtensionAPI): void {
  pi.registerCommand("reload-check", {
    description: "Run one agent turn, reload, then run another turn.",
    async handler(_args, ctx) {
      const settled = new Promise<void>((resolve) => {
        const remove = pi.on("agent_settled", () => {
          remove();
          resolve();
        });
      });
      pi.sendUserMessage("First turn, before reload.", { deliverAs: "followUp" });
      await settled;
      await ctx.reload();
    },
  });
  pi.on("resources_discover", (event) => {
    if (event.reason !== "reload") return;
    pi.sendUserMessage("Second turn, after reload.", { deliverAs: "followUp" });
  });
}
