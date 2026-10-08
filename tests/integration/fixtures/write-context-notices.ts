import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPostEditHandler } from "pi-agent-text-editor/api/post-edit";

/** Add recovery and syntax notices to a saved Write without changing its file bytes. */
export default function writeContextNotices(pi: ExtensionAPI): void {
  connectTextEditorPostEditHandler(pi, {
    id: "fixture-write-context-notices",
    handler(transaction) {
      if (!transaction.resourceSource.endsWith("notice.note")) return;
      return {
        formatting: { status: "failed", formatter: "fixture" },
        diffStatuses: [{ text: "Fixture recovery notice", tone: "warning" }],
        hints: [
          {
            file: transaction.resourceSource,
            line: 1,
            column: 1,
            severity: "error",
            source: "compiler",
            code: "FIXTURE_SYNTAX",
            message: "Fixture syntax problem",
          },
        ],
        scopeMarkers: {},
        warnings: [],
      };
    },
  });
}
