import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  connectTextEditorPlugin,
  TEXT_EDITOR_PROTOCOL,
  TEXT_EDITOR_API_VERSION,
} from "pi-agent-ide/api/text-editor";

const resource = /^fixture:alias-action\/(applied|not-applied|unknown)$/;
/** Return a structured action receipt and record each actual execution. */
export default async function aliasSemanticAction(pi: ExtensionAPI): Promise<void> {
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "alias-semantic-action",
    setup(api) {
      api.addResolver({
        priority: -200,
        resolver: {
          id: "alias-semantic-action",
          async tryResolve(source) {
            if (!resource.test(source)) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                skipPostEdit: true,
                read: async () => [{ type: "text", text: "Synthetic action descriptor." }],
              },
            };
          },
        },
      });
      api.tool("write").addSemanticHandler({
        matches: (input) =>
          typeof input === "object" &&
          input !== null &&
          "path" in input &&
          typeof input.path === "string" &&
          resource.test(input.path),
        async execute(context) {
          const source = context.sourceFor("path");
          const effect = source.slice(source.lastIndexOf("/") + 1);
          await appendFile(path.join(context.cwd, "actions.txt"), effect + "\n");
          const receipt = { effect, delivered: effect === "not-applied" ? 0 : 1 };
          return {
            source,
            summary: `Synthetic action ${effect}.`,
            data: { ...receipt, ok: effect === "applied" },
            script: receipt,
          };
        },
      });
    },
  });
}
