import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deterministic user answers at the host UI boundary, never an agent approval argument. */
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (_event, ctx) => {
    ctx.ui.confirm = async (_title, message) => {
      const approved = message.includes("tracked-yes");
      await appendFile(
        path.join(ctx.cwd, "dialog-decisions.jsonl"),
        JSON.stringify({ message, approved }) + "\n",
      );
      return approved;
    };
  });
}
