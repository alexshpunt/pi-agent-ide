import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resourceScheduler } from "pi-agent-resource";
import { Type } from "typebox";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL } from "pi-agent-read/api/plugin-protocol";
import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";

/** A real Read cannot finish until an independent Search enters. */
export default async function readSearchConcurrencyProbe(pi: ExtensionAPI): Promise<void> {
  let release!: () => void;
  let searchEntered = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  let enterRead!: () => void;
  let readEntered = new Promise<void>((resolve) => { enterRead = resolve; });
  let releaseWriter: (() => void) | undefined;
  let writerDone: Promise<void> | undefined;
  pi.on("session_start", () => {
    searchEntered = new Promise<void>((resolve) => { release = resolve; });
    readEntered = new Promise<void>((resolve) => { enterRead = resolve; });
    events.length = 0;
    releaseWriter = undefined;
    writerDone = undefined;
  });
  pi.registerTool({
    name: "hold_resource", label: "Hold resource", description: "Hold a fixture write reservation",
    parameters: Type.Object({}),
    async execute() {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { releaseWriter = resolve; });
      writerDone = resourceScheduler.run([{ resource: "concurrency:first", mode: "write" }], async () => {
        events.push("writer:enter");
        entered();
        await held;
      });
      await started;
      return { content: [{ type: "text", text: "Reserved concurrency:first" }], details: {} };
    },
  });
  pi.on("session_shutdown", async () => { releaseWriter?.(); await writerDone; });
  await connectReadPlugin(pi, {
    id: "read-search-concurrency", protocol: READ_PROTOCOL, apiVersion: READ_API_VERSION,
    setup(api) {
      api.addResolver({ resolver: {
        id: "concurrency-read",
        async tryResolve(source, context) {
          if (source !== "concurrency:first") return { kind: "not-handled" };
          return { kind: "resolved", resource: {
            source,
            async read() {
              events.push("read:enter");
              enterRead();
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([searchEntered, new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(() => reject(new Error("Read and Search were serialized")), 1500);
                })]);
              } finally { clearTimeout(timer); }
              events.push("read:complete");
              await writeFile(path.join(context.cwd, "read-search-events.json"), JSON.stringify(events));
              return [{ type: "text", text: "read complete" }];
            },
          } };
        },
      }, priority: -100 });
    },
  });
  await connectSearchPlugin(pi, {
    id: "read-search-concurrency", protocol: SEARCH_PROTOCOL, apiVersion: SEARCH_API_VERSION,
    setup(api) {
      api.addResolver({ resolver: {
        id: "concurrency-search",
        readResources: (request) => request.query === "concurrency:second" ? ["concurrency:second"] : [],
        async tryResolve(request) {
          if (request.query !== "concurrency:second") return { kind: "not-handled" };
          if (releaseWriter !== undefined && events.includes("read:enter")) {
            release();
            releaseWriter();
            throw new Error("Read bypassed the shared writer reservation");
          }
          if (releaseWriter === undefined) await readEntered;
          events.push("search:enter");
          release();
          releaseWriter?.();
          return { kind: "resolved", payload: "search complete" };
        },
        format: () => ({ content: [{ type: "text", text: "search complete" }], details: {} }),
        toScriptData: () => ({ kind: "custom", resolverId: "concurrency-search", value: "search complete" }),
      }, priority: -100 });
    },
  });
}
