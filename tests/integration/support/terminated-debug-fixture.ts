import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { retainReloadResource } from "#src/core/reload-resource-store.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

/** Seed an ended session and exercise cleanup through real Pi tool routing. */
export default function terminatedDebugFixture(pi: ExtensionAPI): void {
  const manager = new DebugSessionManager();
  retainReloadResource("debugger", manager);
  pi.registerTool({
    name: "check_debug_cleanup",
    label: "Check debug cleanup",
    description: "Check deletion of an ended debugger session and breakpoint.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const session = manager.create({
        adapter: "debugpy",
        args: [],
        program: path.join(ctx.cwd, "example.py"),
        cwd: ctx.cwd,
      });
      const breakpoint = await manager.addBreakpoint(`${session.source}/source`, 1);
      session.status = "terminated";
      const before = await ctx.executeTool("read", { path: session.source });
      const breakpointDelete = await ctx.executeTool("delete", { path: breakpoint.source });
      const breakpointRead = await ctx.executeTool("read", { path: breakpoint.source });
      const sessionDelete = await ctx.executeTool("delete", { path: session.source });
      const sessionRead = await ctx.executeTool("read", { path: session.source });
      return {
        content: [{ type: "text", text: "Debugger cleanup checked." }],
        details: {
          beforeError: before.isError,
          breakpointDeleteError: breakpointDelete.isError,
          breakpointReadError: breakpointRead.isError,
          sessionDeleteError: sessionDelete.isError,
          sessionReadError: sessionRead.isError,
          breakpointRemoved: !session.breakpoints.has(breakpoint.id),
          sessionRemoved: manager.get(session.source) === undefined,
        },
      };
    },
  });
}
