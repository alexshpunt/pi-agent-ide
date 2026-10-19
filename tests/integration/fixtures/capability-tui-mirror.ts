import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mirrorTuiEvents } from "../../../benchmarks/tool-capabilities/tui.ts";

/** Exercise the paid runner's public event mirror in a credential-free native TUI. */
export default function capabilityTuiMirror(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => {
    if (context.mode !== "tui") throw Error("The mirror fixture requires the native TUI");
    mirrorTuiEvents(pi, path.join(context.cwd, "public-events.jsonl"));
  });
}
