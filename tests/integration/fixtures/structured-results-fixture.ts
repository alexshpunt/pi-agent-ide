import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL } from "pi-agent-read/api/plugin-protocol";
import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "pi-agent-text-editor/api/plugin-protocol";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=";

/** Exercise explicit adapters and failures after a real Resource write. */
export default async function structuredResultsFixture(pi: ExtensionAPI): Promise<void> {
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL, apiVersion: READ_API_VERSION, id: "structured-fixture",
    setup(api) {
      api.addResolver({ resolver: {
        id: "structured-image",
        async tryResolve(source) {
          if (source !== "fixture-image:") return { kind: "not-handled" };
          return { kind: "resolved", resource: {
            source,
            async read() { return [{ type: "image", data: png, mimeType: "image/png" }]; },
          } };
        },
      } });
    },
  });
  await connectSearchPlugin(pi, {
    protocol: SEARCH_PROTOCOL, apiVersion: SEARCH_API_VERSION, id: "structured-fixture",
    setup(api) {
      for (const id of ["missing-adapter", "invalid-adapter"]) api.addResolver({ resolver: {
        id,
        async tryResolve(request) {
          return request.query === `${id}:value` ? { kind: "resolved", payload: { privateData: "not public" } }
            : { kind: "not-handled" };
        },
        async format() { return { content: [{ type: "text", text: "Fixture result" }], details: {} }; },
        ...(id === "invalid-adapter" ? { toScriptData: () => ({ kind: "custom", resolverId: id, value: new Date() }) } : {}),
      } });
    },
  });
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL, apiVersion: TEXT_EDITOR_API_VERSION, id: "structured-fixture",
    setup(api) {
      api.addMutationTool({
        name: "receipt_edit", description: "Use receipt_edit to exercise post-write receipts.",
        source: { field: "path" },
        parameters: Type.Object({ path: Type.String(), text: Type.String(), fail: Type.Optional(Type.Boolean()) }),
        mutate(context, input) {
          const parameters = input as { path: string; text: string; fail?: boolean };
          return {
            edits: new Map([[context.sourceFor("path"), {
              action: "edited",
              changes: [{ from: 0, to: context.sourceDocument.length, insert: parameters.text }],
            }]]),
            afterWrite() { if (parameters.fail) throw new Error("Fixture failed after writing"); },
          };
        },
      });
    },
  });
}
