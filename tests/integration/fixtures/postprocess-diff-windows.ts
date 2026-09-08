import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL } from "pi-agent-ide/api/plugin-protocol";

/** Expands local calls and inserts unrelated text before them. */
export default async function fixture(pi: ExtensionAPI): Promise<void> {
  await connectIdePlugin(pi, {
    protocol: IDE_PROTOCOL,
    apiVersion: IDE_API_VERSION,
    id: "window-fixture",
    setup(api) {
      api.addTool({
        kind: "formatter", name: "window-format", priority: 1000, extensions: [".case"],
        detect: async () => true,
        async format({ filePath }) {
          const before = await readFile(filePath, "utf8");
          const after = "// unrelated header\n" + before.replace(/build\((\d+)\)/g, (_match, value: string) =>
            `build(\n${Array.from({ length: 16 }, (_, i) => `  arg${value}_${i},`).join("\n")}\n)`);
          await writeFile(filePath, after);
          return { ok: true, edits: 1 };
        },
      });
    },
  });
}
