import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Native presentation cases start collapsed rather than using the harness's expanded default. */
export default function codemodePresentationProbe(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setToolsExpanded(false);
  });
}
