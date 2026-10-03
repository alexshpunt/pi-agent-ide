import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "pi-agent-text-editor/api/plugin-protocol";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(promise: Promise<void>, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Require both independent calls to enter before either can finish planning or writing. */
export default async function resourceConcurrencyProbe(pi: ExtensionAPI): Promise<void> {
  let firstPlanEntered = gate();
  let secondPlanned = gate();
  let firstWriteEntered = gate();
  let secondWriteEntered = gate();
  const events: string[] = [];
  pi.on("session_start", () => {
    firstPlanEntered = gate();
    secondPlanned = gate();
    firstWriteEntered = gate();
    secondWriteEntered = gate();
    events.length = 0;
  });
  await connectTextEditorPlugin(pi, {
    id: "resource-concurrency-probe", protocol: TEXT_EDITOR_PROTOCOL, apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addResolver({ priority: -100, resolver: {
        id: "concurrent-file-writes",
        async tryResolve(source, context) {
          const name = path.basename(source);
          if (name !== "first.txt" && name !== "second.txt") return { kind: "not-handled" };
          const file = path.resolve(context.cwd, source);
          return { kind: "resolved", resource: {
            source: file,
            async read() { return [{ type: "text", text: await readFile(file, "utf8") }]; },
            async write(content) {
              events.push(`write:enter:${name}`);
              if (name === "first.txt") {
                firstWriteEntered.resolve();
                await waitFor(secondWriteEntered.promise, "Independent batch writes were serialized");
              } else {
                await waitFor(firstWriteEntered.promise, "Independent batch writes were serialized");
                secondWriteEntered.resolve();
              }
              const text = content.filter((block) => block.type === "text").map((block) => block.text).join("");
              await writeFile(file, text);
              events.push(`write:complete:${name}`);
            },
          } };
        },
      } });
      api.addMutationTool({
        name: "concurrency_probe", description: "Probe independent editor preparation",
        parameters: Type.Object({ path: Type.String() }), source: { field: "path" },
        async mutate(context) {
          const source = context.sourceFor("path");
          const name = path.basename(source);
          events.push(`enter:${name}`);
          if (name === "first.txt") {
            firstPlanEntered.resolve();
            await waitFor(secondPlanned.promise, "Independent native edits were serialized");
          } else {
            await waitFor(firstPlanEntered.promise, "Independent native edits were serialized");
          }
          events.push(`plan:${name}`);
          if (name === "second.txt") secondPlanned.resolve();
          return {
            edits: new Map([[source, {
              action: "edited", changes: [{ from: 0, to: context.sourceDocument.content.length, insert: `updated:${name}` }],
            }]]),
            async afterWrite() {
              await writeFile(path.join(context.cwd, "concurrency-events.json"), JSON.stringify(events));
            },
          };
        },
      });
    },
  });
}
