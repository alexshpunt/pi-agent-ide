import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL } from "pi-agent-read/api/plugin-protocol";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";
import type { ResourceResolver } from "pi-agent-resource";

/** Fail Copy receipt creation after a real memory write, without touching disk resources. */
export default async function registerCopyExecutionProbe(pi: ExtensionAPI): Promise<void> {
  const values = new Map([
    ["c09-probe:source", "alpha\n"],
    ["c09-probe:target", "head\ntail\n"],
  ]);
  const writes: { source: string; text: string }[] = [];
  pi.registerTool({
    name: "fixture_copy_execution_state",
    label: "Copy execution state",
    description: "Inspect memory values and actual writes after a Copy receipt failure.",
    exposure: "codemode",
    parameters: Type.Object({}),
    outputSchema: Type.Object({
      values: Type.Record(Type.String(), Type.String()),
      writes: Type.Array(Type.Object({ source: Type.String(), text: Type.String() })),
    }),
    async execute() {
      const state = { values: Object.fromEntries(values), writes };
      return {
        content: [{ type: "text", text: JSON.stringify(state) }],
        details: undefined,
        structuredContent: state,
      };
    },
  });
  const resolver: ResourceResolver = {
    id: "c09-memory-probe",
    async tryResolve(source) {
      if (!values.has(source)) return { kind: "not-handled" };
      return {
        kind: "resolved",
        resource: {
          source,
          async read() {
            return [{ type: "text", text: values.get(source) ?? "" }];
          },
          async write(content) {
            const block = content[0];
            if (block.type !== "text") throw new Error("Probe accepts only text");
            values.set(source, block.text);
            writes.push({ source, text: block.text });
          },
        },
      };
    },
  };
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "c09-memory-probe",
    setup(api) {
      api.addResolver({ resolver, priority: -100 });
    },
  });
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "c09-memory-probe",
    setup(api) {
      api.addResolver({ resolver, priority: -100 });
      api.addTextPresenter({
        presenter: {
          id: "c09-receipt-failure",
          present(document, context) {
            if (context.purpose !== "edit-diff" || document.source !== "c09-probe:target")
              return document;
            return {
              ...document,
              get content(): string {
                throw new Error("Probe receipt failed after write");
              },
            };
          },
        },
      });
    },
  });
}
