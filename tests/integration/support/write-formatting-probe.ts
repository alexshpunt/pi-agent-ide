import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPostEditHandler } from "pi-agent-text-editor/api/post-edit";

/** Observe real saved bytes and formatting only in the owned Write review fixture. */
export default function writeFormattingProbe(pi: ExtensionAPI): void {
  connectTextEditorPostEditHandler(pi, {
    id: "fixture-write-formatting",
    async handler(transaction) {
      const directory = path.join(transaction.cwd, ".tmp", "post-edit-demo");
      const changed = path.join(directory, "changed.note");
      const unchanged = path.join(directory, "unchanged.note");
      const failed = path.join(directory, "failed.note");
      if (![changed, unchanged, failed].includes(transaction.resourceSource)) return;
      const saved = await readFile(transaction.resourceSource, "utf8");
      const formatted = transaction.resourceSource === changed ? saved.toUpperCase() : saved;
      if (formatted !== saved) await writeFile(transaction.resourceSource, formatted);
      await appendFile(
        path.join(directory, "events.jsonl"),
        JSON.stringify({ source: transaction.resourceSource, saved, final: formatted }) + "\n",
      );
      return {
        formatting: {
          status:
            transaction.resourceSource === failed
              ? "failed"
              : formatted === saved
                ? "unchanged"
                : "changed",
          formatter: "fixture",
        },
        diffStatuses: [
          {
            text:
              transaction.resourceSource === failed
                ? "Formatting failed (fixture)"
                : formatted === saved
                  ? "Already formatted"
                  : "Formatted",
            formatter: "fixture",
            tone: transaction.resourceSource === failed ? "error" : "success",
          },
          { text: "Extra check finished", tone: "muted" },
        ],
      };
    },
  });
}
