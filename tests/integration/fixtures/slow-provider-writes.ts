import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EDIT_WAIT_TIMEOUT_MS, ResourceError, type ResourceResolver } from "pi-agent-resource";
import {
  connectTextEditorPlugin,
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-ide/api/text-editor";

const comments = "fixture://queue/issue/comments/new";
const body = "fixture://queue/pull#body";
const latency = EDIT_WAIT_TIMEOUT_MS + 1_000;

export default async function slowProviderWrites(pi: ExtensionAPI): Promise<void> {
  const resolver: ResourceResolver = {
    id: "slow-provider-writes",
    async tryResolve(source, context) {
      if (source === comments) {
        return {
          kind: "resolved",
          resource: { source, read: async () => [{ type: "text", text: "" }] },
        };
      }
      if (source !== body) return { kind: "not-handled" };
      const file = path.join(context.cwd, "provider-body.txt");
      let snapshot = context.deferSnapshot ? undefined : await readFile(file, "utf8");
      const current = async () => (snapshot ??= await readFile(file, "utf8"));
      return {
        kind: "resolved",
        resource: {
          source,
          skipPostEdit: true,
          read: async () => [{ type: "text", text: await current() }],
          async write(blocks, operation) {
            const block = blocks[0];
            if (block?.type !== "text") throw new Error("Expected provider body text");
            if (snapshot === "old apple\nold pear\n") {
              await setTimeout(latency, undefined, { signal: operation.signal });
            }
            if (snapshot !== (await readFile(file, "utf8"))) {
              throw new ResourceError("FIXTURE_STALE_BODY", source, "not-applied");
            }
            operation.signal?.throwIfAborted();
            await writeFile(file, block.text);
            snapshot = block.text;
          },
        },
      };
    },
  };
  await connectTextEditorPlugin(pi, {
    id: "slow-provider-writes",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addResolver({ resolver, priority: -100 });
      api.tool("write").addSemanticHandler({
        matches: (input) =>
          typeof input === "object" && input !== null && "path" in input && input.path === comments,
        async execute({ cwd, signal }, input) {
          const { content } = input as { content: string };
          if (content === "first") await setTimeout(latency, undefined, { signal });
          signal?.throwIfAborted();
          await appendFile(path.join(cwd, "provider-comments.txt"), content + "\n");
          return {
            source: comments,
            summary: content,
            data: { effect: "applied" },
            script: { effect: "applied" },
          };
        },
      });
    },
  });
}
