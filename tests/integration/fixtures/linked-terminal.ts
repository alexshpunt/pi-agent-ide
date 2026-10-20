import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TerminalSessionSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/types.js";

/** Real terminal jobs are released through their public shell resources, after unrelated work. */
export default function linkedTerminal(pi: ExtensionAPI): void {
  const sessions: TerminalSessionSnapshot[] = [];
  pi.on("tool_result", (event) => {
    if (event.toolName === "bash") sessions.push(event.details as TerminalSessionSnapshot);
  });
  pi.registerTool({
    name: "nested_terminal", label: "Nested terminal", description: "Launch a terminal through another native execution layer.", parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const outcome = await ctx.executeTool("bash", { command: "IFS= read -r answer; printf 'BETA-LATE:%s' \"$answer\"", background: true });
      return { ...outcome.result, isError: outcome.isError };
    },
  });
  pi.registerTool({
    name: "release_terminals", label: "Release terminals", description: "Finish real jobs in reverse launch order.", parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      if (sessions.length !== 2) throw new Error(`Expected two launches, got ${sessions.length}`);
      for (const session of [...sessions].reverse()) {
        const inspected = await ctx.executeTool("read", { path: session.source });
        if (inspected.isError) throw new Error("Session inspection failed");
        const input = await ctx.executeTool("write", { path: session.source, content: "accepted\n" });
        if (input.isError) throw new Error("Session input failed");
      }
      const delivered = () => ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "terminal-completion-display");
      const deadline = Date.now() + 5_000;
      while (delivered().length < 2 && Date.now() < deadline) await delay(20);
      if (delivered().length !== 2) throw new Error("Missing separate completion cards");
      return { content: [{ type: "text", text: "Both jobs finished after inspection and input." }], details: { sessions } };
    },
  });
  let host: (TUI & { layoutRoot: Component; getScreenLines(): string[] }) | undefined;
  pi.on("session_start", async (_event, ctx) => {
    if (!process.env.PI_TERMINAL_STEREO) return;
    let finish = () => {};
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      host = tui as typeof host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (!host) return;
    host.requestRender(true);
    await delay(100);
    const panes: Record<string, string[]> = {};
    const search: Record<string, unknown[]> = {};
    const visit = (component: Component) => {
      const value = component as Component & { pane?: string; children?: Component[]; child?: Component; beginFrame?(): void; searchEntries?(): unknown[] };
      if (value.constructor.name === "NativeDocument" && value.pane) {
        value.beginFrame?.();
        panes[value.pane] = value.render(180);
        search[value.pane] = value.searchEntries?.() ?? [];
        return;
      }
      for (const child of value.children ?? []) visit(child);
      if (value.child) visit(value.child);
    };
    visit(host.layoutRoot);
    await writeFile(process.env.PI_TERMINAL_CAPTURE ?? path.join(ctx.cwd, "terminal-panes.json"), JSON.stringify({ panes, search, screen: host.getScreenLines() }));
  });
}
