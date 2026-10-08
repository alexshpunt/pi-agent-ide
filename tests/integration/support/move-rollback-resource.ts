import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";

/** Inject failures only in owned .tmp/move-rollback files; optional logs record each write attempt. */
export default async function moveRollbackResource(
  pi: ExtensionAPI,
  recordAttempts = true,
): Promise<void> {
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "fixture-move-rollback",
    setup(api) {
      api.addResolver({
        priority: -100,
        resolver: {
          id: "fixture-move-rollback-files",
          async tryResolve(source, context) {
            const directory = path.resolve(context.cwd, ".tmp/move-rollback");
            const file = path.resolve(context.cwd, source);
            const match =
              /^(restored|target-failed|target-failed-after-restore|source-failed)-(source|target)\.txt$/u.exec(
                path.basename(file),
              );
            if (path.dirname(file) !== directory || match === null) return { kind: "not-handled" };
            const [, scenario, role] = match;
            let attempts = 0;
            return {
              kind: "resolved",
              resource: {
                source: file,
                async read(operation) {
                  return [
                    {
                      type: "text",
                      text: await readFile(file, { encoding: "utf8", signal: operation.signal }),
                    },
                  ];
                },
                async write(content, operation) {
                  operation.signal?.throwIfAborted();
                  const block = content[0];
                  if (content.length !== 1 || block.type !== "text")
                    throw new Error("Fixture requires one text block");
                  const attempt = ++attempts;
                  if (recordAttempts)
                    await appendFile(
                      path.join(directory, "events.jsonl"),
                      JSON.stringify({ file, attempt, content: block.text }) + "\n",
                    );
                  if (
                    attempt > 1 &&
                    ((scenario === "target-failed" && role === "target") ||
                      (scenario === "source-failed" && role === "source"))
                  )
                    throw new Error("Injected rollback failure before restoration");
                  await writeFile(file, block.text, { signal: operation.signal });
                  if (attempt === 1 && role === "target")
                    throw new Error("Injected Move write failure after saving content");
                  if (
                    attempt > 1 &&
                    scenario === "target-failed-after-restore" &&
                    role === "target"
                  )
                    throw new Error("Injected rollback failure after restoration");
                },
              },
            };
          },
        },
      });
    },
  });
}
