import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deterministic user answers at the host UI boundary, never an agent approval argument. */
export default function (pi: ExtensionAPI) {
  const blocked: unknown[] = [];
  pi.events.on("herdr:blocked", (event) => blocked.push(event));
  pi.on("tool_result", async (_event, ctx) => {
    await writeFile(path.join(ctx.cwd, "herdr-events.json"), JSON.stringify(blocked));
  });
  pi.on("tool_call", (_event, ctx) => {
    ctx.ui.select = async (title) => {
      // Shared approval puts the request message between its title and the scope line.
      const message = title.slice(title.indexOf("\n") + 1, title.lastIndexOf("\nScope: "));
      const approved = message.includes("tracked-yes");
      await appendFile(
        path.join(ctx.cwd, "dialog-decisions.jsonl"),
        JSON.stringify({ message, approved, blockedAtOpen: blocked.at(-1) }) + "\n",
      );
      return approved ? "Allow once" : "Deny";
    };
  });
}
