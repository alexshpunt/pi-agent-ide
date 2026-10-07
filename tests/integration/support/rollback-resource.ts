import path from "node:path";
import { requiredValue } from "pi-agent-invariant";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";

/** Isolated text resources with write and rollback failures. No filesystem writes are made. */
export default async function rollbackResource(pi: ExtensionAPI): Promise<void> {
  const values = new Map([
    ["rollback-restored.txt", "KEEP\n"],
    ["rollback-failed.txt", "KEEP\n"],
    ["rollback-failed-after-restore.txt", "KEEP\n"],
  ]);
  const attempts = new Map<string, string[]>();
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "rollback-fixture",
    setup(api) {
      api.addResolver({
        priority: -100,
        resolver: {
          id: "rollback-resource",
          async tryResolve(source) {
            const name = path.basename(source);
            if (!values.has(name)) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  return [{ type: "text", text: requiredValue(values.get(name)) }];
                },
                async write(content) {
                  const item = content[0];
                  if (item.type !== "text") throw new Error("Expected text content");
                  const history = [...(attempts.get(name) ?? []), item.text];
                  attempts.set(name, history);
                  if (history.length === 1) {
                    values.set(name, item.text);
                    throw new Error("Injected write failure after changing bytes");
                  }
                  if (name !== "rollback-failed.txt") values.set(name, item.text);
                  if (name !== "rollback-restored.txt")
                    throw new Error("Injected rollback failure");
                },
              },
            };
          },
        },
      });
    },
  });
  pi.registerTool({
    name: "rollback_state",
    label: "Rollback resource state",
    description: "Read the actual bytes and write attempts of isolated rollback resources.",
    parameters: Type.Object({}),
    outputSchema: Type.String(),
    async execute() {
      const value = JSON.stringify(
        [...values].map(([source, text]) => ({
          source,
          text,
          writes: attempts.get(source) ?? [],
        })),
      );
      return {
        content: [{ type: "text", text: value }],
        details: {},
        structuredContent: value,
      };
    },
  });
}
