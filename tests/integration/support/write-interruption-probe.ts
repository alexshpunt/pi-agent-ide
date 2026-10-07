import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import { connectTextEditorPostEditHandler } from "pi-agent-text-editor/api/post-edit";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";

/** Observe deadline effects before and after persistence for owned fixture files. */
export default async function writeInterruptionProbe(pi: ExtensionAPI): Promise<void> {
  pi.on("tool_result", async (event) => {
    if (
      event.toolName === "codemode" &&
      typeof event.input.code === "string" &&
      event.input.code.includes(".tmp/write-interruption/")
    )
      // Keep the runner's real workspace alive until the cancelled guard settles.
      await delay(4500);
  });
  const record = async (cwd: string, stage: string, source: string, signal?: AbortSignal) => {
    await appendFile(
      path.join(cwd, ".tmp/write-interruption/events.jsonl"),
      JSON.stringify({
        stage,
        source,
        aborted: signal?.aborted ?? false,
        content: await readFile(source, "utf8").catch(() => null),
      }) + "\n",
    );
  };
  connectTextEditorPostEditHandler(pi, {
    id: "fixture-write-interruption-post-save",
    async handler(transaction) {
      const source = path.resolve(transaction.cwd, ".tmp/write-interruption/after-save.note");
      if (transaction.resourceSource !== source) return;
      await record(transaction.cwd, "post-save-start", source, transaction.signal);
      try {
        await delay(4000, undefined, { signal: transaction.signal });
      } finally {
        await record(transaction.cwd, "post-save-end", source, transaction.signal);
      }
    },
  });
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "fixture-write-interruption",
    setup(api) {
      api.addMutationGuard({
        id: "fixture-write-interruption-pre-save",
        async guard(plan, context) {
          const source = plan.resources.find((resource) =>
            ["before-save.note", "unknown.note"].some(
              (name) =>
                resource.source === path.resolve(context.cwd, ".tmp/write-interruption", name),
            ),
          )?.source;
          if (source === undefined) return { kind: "accepted" };
          await record(context.cwd, "guard-start", source, context.signal);
          // One guard remains unresolved while parent history is saved; the other settles first.
          // Both deliberately ignore abort so the editor must prevent late writes.
          await delay(path.basename(source) === "unknown.note" ? 10000 : 4000);
          await record(context.cwd, "guard-end", source, context.signal);
          return { kind: "accepted" };
        },
      });
    },
  });
}
