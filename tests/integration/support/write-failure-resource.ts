import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";

/** Fail real writes only in the owned .tmp/write-failure fixture directory. */
export default async function writeFailureResource(pi: ExtensionAPI): Promise<void> {
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "fixture-write-failure",
    setup(api) {
      api.addResolver({
        priority: -100,
        resolver: {
          id: "fixture-write-failure-files",
          async tryResolve(source, context) {
            const directory = path.resolve(context.cwd, ".tmp/write-failure");
            const file = path.resolve(context.cwd, source);
            const name = path.basename(file);
            if (
              path.dirname(file) !== directory ||
              !["rollback-ok.txt", "rollback-failed.txt", "rollback-new.txt"].includes(name)
            )
              return { kind: "not-handled" };
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
                  await appendFile(
                    path.join(directory, "events.jsonl"),
                    JSON.stringify({ file, attempt, content: block.text }) + "\n",
                  );
                  if (attempt > 1 && name === "rollback-failed.txt")
                    throw new Error("Injected rollback failure before restoration");
                  await writeFile(file, block.text, { signal: operation.signal });
                  if (attempt === 1) throw new Error("Injected failure after saving content");
                },
              },
            };
          },
        },
      });
    },
  });
}
