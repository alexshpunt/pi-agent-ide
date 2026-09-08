import { readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL } from "pi-agent-ide/api/plugin-protocol";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Count automatic work separately from explicitly requested diagnostics. */
export default async function runtimeOptionsFixture(pi: ExtensionAPI): Promise<void> {
  let formats = 0;
  let diagnostics = 0;
  await connectIdePlugin(pi, {
    protocol: IDE_PROTOCOL,
    apiVersion: IDE_API_VERSION,
    id: "runtime-options-fixture",
    setup(api) {
      api.addTool({ kind: "formatter", name: "runtime-options-format", priority: 10000, extensions: [".fixture"],
        detect: async () => true,
        async format({ filePath }) {
          formats++;
          await writeFile(filePath, (await readFile(filePath, "utf8")).trim() + "\n");
          return { ok: true, edits: 1 };
        },
      });
      api.addDiagnosticSource({ id: "runtime-options-diagnostics", async diagnose() {
        diagnostics++;
        return { status: "ready", diagnostics: [] };
      } });
    },
  });
  pi.registerTool({
    name: "runtime_options_probe", label: "Runtime options probe", description: "Read test counters and effective flags.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "Runtime counters" }], details: {
        formats, diagnostics,
      } };
    },
  });
}
