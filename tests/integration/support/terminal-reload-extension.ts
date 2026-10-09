import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Drive a real command reload only after public terminal tools finish their first agent turn. */
export default function registerTerminalReloadFixture(pi: ExtensionAPI): void {
  const stateFile = (cwd: string) => path.join(cwd, "terminal-reload-state.json");
  pi.registerCommand("terminal-lifecycle", {
    description: "Reload after retaining completed and live terminal resources.",
    async handler(_args, ctx) {
      const settled = new Promise<void>((resolve) => {
        const remove = pi.on("agent_settled", () => {
          remove();
          resolve();
        });
      });
      pi.sendUserMessage("Create local, remote and live terminal sessions.", {
        deliverAs: "followUp",
      });
      await settled;
      await ctx.reload();
    },
  });
  pi.on("resources_discover", async (event) => {
    if (event.reason !== "reload") return;
    await writeFile(
      path.join(event.cwd, "terminal-reloaded.json"),
      JSON.stringify({ reason: event.reason }),
    );
    pi.sendUserMessage("Read and delete the retained terminal sessions.", {
      deliverAs: "followUp",
    });
  });
  pi.on("tool_result", async (event, ctx) => {
    if (!["local", "remote", "live"].includes(event.toolCallId)) return;
    const output = event.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const reference = /session: (shell:[a-f0-9]+)/u.exec(output)?.[1];
    if (!reference) throw new Error("Terminal result has no real session reference");
    let state: Record<string, string> = {};
    try {
      state = JSON.parse(await readFile(stateFile(ctx.cwd), "utf8")) as Record<string, string>;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    state[event.toolCallId] = reference;
    await writeFile(stateFile(ctx.cwd), JSON.stringify(state));
  });
  pi.on("tool_call", async (event, ctx) => {
    if (
      !("path" in event.input) ||
      typeof event.input.path !== "string" ||
      !event.input.path.startsWith("lifecycle:")
    )
      return;
    const state: Record<string, string> = JSON.parse(
      await readFile(stateFile(ctx.cwd), "utf8"),
    ) as Record<string, string>;
    const reference = state[event.input.path.slice("lifecycle:".length)];
    if (!reference) throw new Error("No retained terminal reference");
    event.input.path = reference;
  });
}
