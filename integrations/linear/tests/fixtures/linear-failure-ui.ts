import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ResourceError, type ResourceResolver } from "pi-agent-ide/api/resource";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL } from "pi-agent-ide/api/read";
import { connectTextEditorPlugin, TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "pi-agent-ide/api/text-editor";

export const failureSource = "linear://example/document/90000000-0000-4000-8000-000000000746/content";
export const genericFailureSource = "fixture://linear-failure-proof/content";

/** Persist once, then lose the acknowledgement; never intercept a real workspace. */
export default async function linearFailureUi(pi: ExtensionAPI): Promise<void> {
  pi.on("session_start", (_event, context) => {
    context.ui.setToolsExpanded(process.env.LINEAR_FAILURE_EXPANDED === "1");
  });
  const resolver: ResourceResolver = {
    id: "linear-failure-ui-fixture",
    async tryResolve(source, context) {
      if (source !== failureSource && source !== genericFailureSource) return { kind: "not-handled" };
      const directory = path.join(context.cwd,
        source === failureSource ? ".tmp/linear-failure-proof" : ".tmp/generic-failure-proof");
      const file = path.join(directory, "saved.md");
      return {
        kind: "resolved",
        resource: {
          source,
          async read() {
            let saved: string;
            try { saved = await readFile(file, "utf8"); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              saved = "Before";
            }
            return [{ type: "text", text: saved }];
          },
          async write(content, operation) {
            operation.signal?.throwIfAborted();
            if (content.length !== 1 || content[0].type !== "text")
              throw new ResourceError("LINEAR_TEXT_REQUIRED", source, "not-applied");
            await mkdir(directory, { recursive: true });
            await appendFile(path.join(directory, "attempts.log"), "write\n");
            const saved = "Lost content";
            await writeFile(file, saved, "utf8");
            throw new ResourceError(source === failureSource
              ? "LINEAR_AXI_FAILED" : "PROVIDER_SAVE_VERIFICATION_FAILED", source, "unknown");
          },
        },
      };
    },
  };
  await Promise.all([
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL, apiVersion: TEXT_EDITOR_API_VERSION, id: resolver.id,
      setup(api) {
        api.addResolver({ resolver, priority: -1000 });
      },
    }),
    connectReadPlugin(pi, {
      protocol: READ_PROTOCOL, apiVersion: READ_API_VERSION, id: resolver.id,
      setup(api) { api.addResolver({ resolver, priority: -1000 }); },
    }),
  ]);
}
