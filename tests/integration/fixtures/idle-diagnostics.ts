import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdeDiagnosticContext } from "pi-agent-ide/api/plugin-protocol";

/** Publish a real provider result only after Pi has stopped its first agent run. */
export default async function idleDiagnostics(pi: ExtensionAPI): Promise<void> {
  let context: IdeDiagnosticContext | undefined;
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const report = {
    status: "ready" as const,
    source: "late-checker",
    diagnostics: [{ line: 1, column: 1, code: "late", severity: "error" as const, message: "Late real finding" }],
  };
  await connectIdePlugin(pi, {
    protocol: IDE_PROTOCOL, apiVersion: IDE_API_VERSION, id: "idle-diagnostics",
    setup(api) {
      api.addDiagnosticSource({
        id: "late",
        async diagnose(_file, current) {
          context = current;
          return { status: "ready", diagnostics: [] };
        },
      });
      pi.registerTool({
        name: "arm_diagnostics", label: "Arm diagnostics", description: "Start a controlled background check.",
        parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          await api.readDiagnostics(path.join(ctx.cwd, "example.ts"), { cwd: ctx.cwd });
          armed = true;
          return { content: [{ type: "text", text: "Armed" }], details: {} };
        },
      });
    },
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!armed) return;
    armed = false;
    timer = setTimeout(() => {
      void writeFile(path.join(ctx.cwd, "idle-observed.json"), JSON.stringify({ idle: ctx.isIdle() }))
        .then(() => context?.publish(report));
    }, 30);
  });
  pi.on("session_shutdown", () => clearTimeout(timer));
  pi.registerTool({
    name: "ack_diagnostics", label: "Acknowledge diagnostics", description: "Record the diagnostic wakeup and repeat the same report.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      context?.publish(report);
      await writeFile(path.join(ctx.cwd, "acknowledged.txt"), "acknowledged");
      return { content: [{ type: "text", text: "Acknowledged" }], details: {} };
    },
  });
}
