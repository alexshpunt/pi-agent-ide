import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPostEditHandler } from "pi-agent-text-editor/api/post-edit";

/** Make final processing visible without replacing the real editor or mutation guards. */
export default function nativePostEditProbe(pi: ExtensionAPI): void {
  connectTextEditorPostEditHandler(pi, {
    id: "composition-post-edit-probe",
    async handler(transaction) {
      if (!transaction.resourceSource.endsWith("format.txt")) return;
      await appendFile(
        path.join(path.dirname(transaction.resourceSource), "post-edit-events.jsonl"),
        JSON.stringify({
          source: transaction.resourceSource,
          content: transaction.requestedAfter.content,
        }) + "\n",
      );
      const formatted = transaction.requestedAfter.content.replaceAll("format_me", "FORMATTED");
      await writeFile(transaction.resourceSource, formatted);
      return {
        formatting: { status: "changed", formatter: "fixture" },
        diffStatuses: [
          { formatter: "fixture", text: "Fixture formatting finished", tone: "success" },
        ],
      };
    },
  });
}
