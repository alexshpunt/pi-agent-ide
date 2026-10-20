import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { DebugMcpClient } from "#src/plugins/pi-agent-ide-debugger/src/debugmcp-client.js";
import { debugMcpPort } from "#src/plugins/pi-agent-ide-debugger/src/vscode-backend.js";

/** Drive public debugger tools against the VS Code window that has the test workspace open. */
export default function vscodeDebuggerFixture(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "check_vscode_debugger",
    label: "Check VS Code debugger",
    description: "Run one debugger scenario through public tools and report VS Code state.",
    parameters: Type.Object({
      scenario: Type.Union([
        Type.Literal("auto"),
        Type.Literal("native"),
        Type.Literal("configuration"),
        Type.Literal("test"),
        Type.Literal("user-session"),
      ]),
    }),
    async execute(_id, { scenario }, signal, _onUpdate, ctx) {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await ctx.executeTool(name, args, { signal });
        return {
          isError: result.isError,
          text: result.result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
            .replace(/^<system-result[^]*?<\/system-result>\n/u, ""),
          details: result.result.details as unknown,
        };
      };
      const vscode = await DebugMcpClient.connect(debugMcpPort(), signal);
      const vscodeState = async () => ({
        status: JSON.parse(await vscode.call("get_debug_status", {})) as unknown,
        breakpoints: await vscode.call("list_breakpoints", {}),
      });
      const steps: Record<string, unknown> = {};
      try {
        await vscode.call("remove_breakpoint", { fileFullPath: `${ctx.cwd}/task.py`, line: 0 });
        if (scenario === "user-session") {
          await vscode.call("add_breakpoint", { fileFullPath: `${ctx.cwd}/task.py`, line: 10 });
          steps.userStart = await vscode.call("start_debugging", {
            fileFullPath: `${ctx.cwd}/task.py`,
            workingDirectory: ctx.cwd,
          });
          steps.vscodeRefusal = await call("debug", { backend: "vscode", program: "task.py" });
          steps.autoFallback = await call("debug", { adapter: "debugpy", program: "task.py" });
          steps.vscodeAfter = await vscodeState();
          await vscode.call("stop_debugging", {});
          await vscode.call("remove_breakpoint", { fileFullPath: `${ctx.cwd}/task.py`, line: 10 });
          return { content: [{ type: "text", text: "checked" }], details: steps };
        }
        // A breakpoint the user already set must survive Pi's session; other.py never runs.
        await vscode.call("add_breakpoint", { fileFullPath: `${ctx.cwd}/other.py`, line: 1 });
        const program = scenario === "test" ? "test_task.py" : "task.py";
        const line = scenario === "test" ? 6 : scenario === "configuration" ? 10 : 6;
        const expression =
          scenario === "test"
            ? "result"
            : scenario === "configuration"
              ? "str(sys.argv[1:])"
              : "subtotal";
        const created = await call("debug", {
          program,
          ...(scenario === "native" ? { backend: "native", adapter: "debugpy" } : {}),
          ...(scenario === "configuration" ? { configuration: "Task with args" } : {}),
          ...(scenario === "test" ? { test: "test_total" } : {}),
        });
        steps.created = created;
        const session = /debug:[a-f\d]{12}/u.exec(created.text)?.[0];
        if (session === undefined) throw new Error(`Debug returned no session: ${created.text}`);
        const source = await call("read", { path: `${session}/source`, views: ["anchors"] });
        const anchor = new RegExp(`(?:^|\\n) *(${line}#[A-F\\d]+)\\|`, "u").exec(source.text)?.[1];
        if (anchor === undefined) {
          throw new Error(
            `Source returned no line-${line} anchor:\n${created.text}\n${source.text}`,
          );
        }
        steps.breakpoint = await call("insert", {
          path: `${session}/source`,
          anchor,
          text: "breakpoint",
        });
        steps.vscodeWithBreakpoint = await vscodeState();
        steps.started = await call("insert", { path: session, text: "start" });
        steps.vscodeStopped = await vscodeState();
        steps.evaluated = await call("insert", { path: session, text: `evaluate ${expression}` });
        steps.stepped = await call("insert", { path: session, text: "step over" });
        steps.read = await call("read", { path: session });
        const breakpoint = /debug:[a-f\d]{12}\/breakpoint\/[a-f\d]{10}/u.exec(
          steps.read && typeof steps.read === "object" && "text" in steps.read
            ? String(steps.read.text)
            : "",
        )?.[0];
        if (breakpoint !== undefined)
          steps.breakpointDeleted = await call("delete", { path: breakpoint });
        steps.sessionDeleted = await call("delete", { path: session });
        steps.sessionReadAfterDelete = await call("read", { path: session });
        // VS Code ends a stopped session asynchronously after DebugMCP's stop request.
        const deletedAt = Date.now();
        while (
          Date.now() - deletedAt < 10_000 &&
          (JSON.parse(await vscode.call("get_debug_status", {})) as { status: string }).status !==
            "no-session"
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
        steps.vscodeEndedAfterMs = Date.now() - deletedAt;
        steps.vscodeAfter = await vscodeState();
        return { content: [{ type: "text", text: "checked" }], details: steps };
      } finally {
        await vscode.call("remove_breakpoint", { fileFullPath: `${ctx.cwd}/other.py`, line: 1 });
        await vscode.close();
      }
    },
  });
}
