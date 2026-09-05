import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Starts history checks through Pi's normal session replacement path. */
export default function restoreToolHistory(pi: ExtensionAPI): void {
  pi.registerCommand("restore-tool-history", {
    description: "Restore the isolated test session",
    async handler(_args, ctx) {
      const session = process.env.IDE_RESTORE_SESSION;
      if (session === undefined) throw new Error("Missing test session path");
      await ctx.switchSession(session, {
        async withSession(current) {
          await current.sendUserMessage("History restored");
        },
      });
    },
  });
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setToolsExpanded(process.env.IDE_HISTORY_EXPANDED === "1");
  });
}
