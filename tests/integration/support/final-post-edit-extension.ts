import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPostEditHandler } from "pi-agent-text-editor/api/post-edit";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_PROTOCOL, IDE_API_VERSION } from "pi-agent-ide/api/plugin-protocol";

/** Real file-backed formatting and diagnostics with observable invocation counts. */
export default async function finalPostEditFixture(pi: ExtensionAPI): Promise<void> {
  connectTextEditorPostEditHandler(pi, {
    id: "fixture-final-formatter",
    async handler(transaction) {
      if (!transaction.resourceSource.endsWith(".note")) return;
      const content = await readFile(transaction.resourceSource, "utf8");
      await appendFile(
        path.join(transaction.cwd, "format-events.jsonl"),
        JSON.stringify({ path: transaction.resourceSource, content }) + "\n",
      );
      await writeFile(transaction.resourceSource, content.toUpperCase());
      return {
        formatting: { status: "changed", formatter: "fixture" },
        diffStatuses: [{ text: "Formatted", formatter: "fixture", tone: "success" }],
      };
    },
  });
  await connectIdePlugin(pi, {
    protocol: IDE_PROTOCOL,
    apiVersion: IDE_API_VERSION,
    id: "fixture-final-diagnostics",
    setup(api) {
      api.addDiagnosticSource({
        id: "fixture-check",
        async diagnose(file, context) {
          await appendFile(
            path.join(context.cwd, "diagnostic-events.jsonl"),
            JSON.stringify({ path: file, content: context.content }) + "\n",
          );
          return { status: "ready", diagnostics: [] };
        },
      });
    },
  });
}
