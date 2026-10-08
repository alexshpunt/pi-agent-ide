import path from "node:path";
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

/** Exercise real Copy rollback results using only memory resources. */
export default async function registerCopyRollbackProbe(pi: ExtensionAPI): Promise<void> {
  const values = new Map([
    ["c07-probe:source", "alpha\n"],
    ["c07-probe:restored", "head\ntail\n"],
    ["c07-probe:unrestored", "head\ntail\n"],
  ]);
  const attempts: { source: string; text: string; outcome: string }[] = [];
  const counts = new Map<string, number>();
  const effects: { target: string; effect: string; isError: boolean }[] = [];
  const snapshot = () => ({ values: Object.fromEntries(values), attempts, effects });
  const sourceKey = (source: string): string => {
    const names: Record<string, string> = {
      "rollback-source.txt": "c07-probe:source",
      "rollback-restored.txt": "c07-probe:restored",
      "rollback-unrestored.txt": "c07-probe:unrestored",
    };
    return names[path.basename(source)] ?? source;
  };
  pi.on("tool_result", (event) => {
    const inputTarget = event.input.target;
    const target = typeof inputTarget === "string" ? sourceKey(inputTarget) : undefined;
    if (event.toolName !== "copy" || typeof target !== "string" || !values.has(target)) return;
    const details = event.details as { effect?: string } | undefined;
    effects.push({ target, effect: details?.effect ?? "missing", isError: event.isError });
  });
  pi.registerTool({
    name: "fixture_copy_rollback_state",
    label: "Copy rollback state",
    description: "Inspect memory values, write attempts and actual Copy effects.",
    exposure: "codemode",
    parameters: Type.Object({}),
    outputSchema: Type.Object({
      values: Type.Record(Type.String(), Type.String()),
      attempts: Type.Array(
        Type.Object({ source: Type.String(), text: Type.String(), outcome: Type.String() }),
      ),
      effects: Type.Array(
        Type.Object({ target: Type.String(), effect: Type.String(), isError: Type.Boolean() }),
      ),
    }),
    async execute() {
      const state = snapshot();
      return {
        content: [{ type: "text", text: JSON.stringify(state) }],
        details: undefined,
        structuredContent: state,
      };
    },
  });
  const resolver: ResourceResolver = {
    id: "c07-memory-probe",
    async tryResolve(source) {
      if (source === "c07-probe:stats") {
        return {
          kind: "resolved",
          resource: {
            source,
            async read() {
              return [
                {
                  type: "text",
                  text:
                    JSON.stringify({ values: Object.fromEntries(values), attempts }, null, 2) +
                    "\n",
                },
              ];
            },
          },
        };
      }
      const key = sourceKey(source);
      if (!values.has(key)) return { kind: "not-handled" };
      return {
        kind: "resolved",
        resource: {
          source,
          async read() {
            return [{ type: "text", text: values.get(key) ?? "" }];
          },
          async write(content) {
            const block = content[0];
            if (block.type !== "text") throw new Error("Probe accepts only text");
            const attempt = (counts.get(key) ?? 0) + 1;
            counts.set(key, attempt);
            if (key === "c07-probe:unrestored" && attempt > 1) {
              attempts.push({
                source,
                text: block.text,
                outcome: "rollback rejected before mutation",
              });
              throw new Error("Probe rollback failed");
            }
            values.set(key, block.text);
            if (key !== "c07-probe:source" && attempt === 1) {
              attempts.push({ source, text: block.text, outcome: "write rejected after mutation" });
              throw new Error("Probe write failed after mutation");
            }
            attempts.push({ source, text: block.text, outcome: "write succeeded" });
          },
        },
      };
    },
  };
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "c07-memory-probe",
    setup(api) {
      api.addResolver({ resolver, priority: -100 });
    },
  });
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "c07-memory-probe",
    setup(api) {
      api.addResolver({ resolver, priority: -100 });
    },
  });
}
