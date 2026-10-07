import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";

/** Fail presentation or a post-edit handler only for owned execution-failure fixture files. */
export default async function executionFailurePresenter(pi: ExtensionAPI): Promise<void> {
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "fixture-execution-failure",
    setup(api) {
      api.tool("write").addHandler({
        stage: "text-post-edit",
        async handler(state) {
          const input = state.input as { path?: unknown };
          const source = path.resolve(state.cwd, ".tmp/execution-failure/post-handler.txt");
          if (typeof input.path !== "string" || path.resolve(state.cwd, input.path) !== source)
            return state;
          await writeFile(path.join(state.cwd, ".tmp/execution-failure/unreported.txt"), "peer\n");
          throw new Error("Injected post-edit failure with an unreported resource effect");
        },
      });
      api.addTextPresenter({
        priority: -100,
        presenter: {
          id: "fixture-failed-edit-presentation",
          async present(document, context) {
            const source = path.resolve(context.cwd, ".tmp/execution-failure/presenter.txt");
            if (context.purpose !== "edit-diff" || context.source !== source) return document;
            await appendFile(
              path.join(context.cwd, ".tmp/execution-failure/events.jsonl"),
              JSON.stringify({ source, content: await readFile(source, "utf8") }) + "\n",
            );
            throw new Error("Injected edit presentation failure after saving the file");
          },
        },
      });
    },
  });
}
