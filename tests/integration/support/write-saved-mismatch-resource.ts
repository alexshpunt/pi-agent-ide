import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ResourceError } from "pi-agent-resource";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";

/** A bounded remote-write fixture saves text before returning an uncertain verification result. */
export default async function writeSavedMismatchResource(pi: ExtensionAPI): Promise<void> {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setToolsExpanded(process.env.WRITE_FAILURE_EXPANDED === "1");
  });
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "fixture-saved-mismatch",
    setup(api) {
      api.addResolver({
        priority: -100,
        resolver: {
          id: "fixture-saved-mismatch-resource",
          async tryResolve(source, context) {
            if (source !== "fixture://saved-mismatch/content") return { kind: "not-handled" };
            const file = path.join(context.cwd, "saved.md");
            return {
              kind: "resolved",
              resource: {
                source,
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
                  await appendFile(
                    path.join(context.cwd, "attempts.jsonl"),
                    JSON.stringify({ content: block.text }) + "\n",
                  );
                  await writeFile(file, block.text, { signal: operation.signal });
                  throw new ResourceError("LINEAR_SAVED_CONTENT_MISMATCH", source, "unknown");
                },
              },
            };
          },
        },
      });
    },
  });
}
