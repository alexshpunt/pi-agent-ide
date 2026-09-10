import { setTimeout } from "node:timers/promises";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdePluginApi } from "pi-agent-ide/api/plugin-protocol";
import { connectTextEditorPostEditHandler } from "pi-agent-ide/api/text-editor";

/** Deterministic formatting, plugin statuses, and diagnostics through the public APIs. */
export default async function fixture(pi: ExtensionAPI): Promise<void> {
  let api: IdePluginApi;
  connectTextEditorPostEditHandler(pi, {
    id: "status-fixture",
    handler: ({ resourceSource }) => ({
      diffStatuses: [{ text: `checked-${path.basename(resourceSource)}`, tone: "muted" }],
    }),
  });
  await connectIdePlugin(pi, {
    protocol: IDE_PROTOCOL, apiVersion: IDE_API_VERSION, id: "status-diagnostics-fixture",
    setup(value) {
      api = value;
      value.addTool({
        kind: "formatter", name: "fixture-format", priority: 1000, extensions: [".case"],
        detect: async () => true,
        async format({ filePath }) {
          const before = await readFile(filePath, "utf8");
          const after = `${before.trim()}\n`;
          await writeFile(filePath, after);
          return { ok: true, edits: before === after ? 0 : 1 };
        },
      });
      value.addDiagnosticSource({
        id: "fixture-check",
        async diagnose() {
          return { status: "snapshot", diagnostics: (["error", "warning"] as const).map((severity) => ({
            severity, line: 1, column: 1, code: "fixture-code", message: "private-fixture-detail",
          })) };
        },
      });
    },
  });
  pi.registerTool({
    name: "await_diagnostics", label: "Await diagnostics", description: "Wait for fixture reports.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      for (const file of ["first.case", "second.case"]) await api.readDiagnostics(file, { cwd: ctx.cwd });
      await setTimeout(5500);
      return { content: [{ type: "text", text: "Reports ready" }], details: {} };
    },
  });
}
