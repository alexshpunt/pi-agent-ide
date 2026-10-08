import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Exercise compact renderer contracts instead of the test harness's expanded default. */
export default function compactToolPresentation(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (_event, context) => context.ui.setToolsExpanded(false));
}
