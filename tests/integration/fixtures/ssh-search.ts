import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Feed the actual ordinary search result into the later scripted replace call. */
export default function sshSearchFixture(pi: ExtensionAPI): void {
  let selection: string | undefined;
  pi.on("tool_result", (event) => {
    if (!["search", "ast_search"].includes(event.toolName) || selection !== undefined) return;
    selection = /SEARCH#[0-9A-F]{4,64}:all:match/u.exec(JSON.stringify(event.content))?.[0];
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== "replace") return;
    const input = event.input as Record<string, unknown>;
    if (input.start !== "SEARCH#0000:all:match") return;
    if (selection === undefined) throw new Error("Search did not register its remote selection");
    input.start = selection;
  });
}
