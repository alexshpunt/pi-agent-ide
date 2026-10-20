import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";

const SOURCE = "receipt:probe";

/** A provider action through Insert that changes no file and reports only its own receipt text. */
export default async function semanticInsertReceipt(pi: ExtensionAPI): Promise<void> {
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "semantic-insert-receipt",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "receipt-probe",
          async tryResolve(requested) {
            if (requested !== SOURCE) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source: SOURCE,
                async read() {
                  return [{ type: "text", text: "Probe ready" }];
                },
              },
            };
          },
        },
      });
      api.tool("insert").addSemanticHandler({
        matches: (input) => (input as { path?: unknown }).path === SOURCE,
        async execute(_context, input) {
          const { text } = input as { text: string };
          return {
            source: SOURCE,
            summary: `Probe receipt: ${text} delivered`,
            data: { kind: "probe-action", ok: true, effect: "applied" },
          };
        },
      });
    },
  });
}
