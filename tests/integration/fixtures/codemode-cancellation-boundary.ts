import { setTimeout } from "node:timers/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL } from "pi-agent-read/api/plugin-protocol";
import { Type } from "typebox";

function latch() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

export default async function cancellationBoundary(pi: ExtensionAPI): Promise<void> {
  const allReadsStarted = latch();
  const scriptEnded = latch();
  const seen = new Set<string>();
  const paths = new Set([
    "fixture:direct-a",
    "fixture:direct-b",
    "fixture:nested-a",
    "fixture:nested-b",
  ]);

  pi.on("tool_execution_end", (event) => {
    if (event.toolCallId === "failed-script") scriptEnded.release();
  });

  pi.registerTool({
    name: "wait_for_reads",
    label: "Wait for reads",
    description: "Return once the four fixture reads have started",
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      await Promise.race([
        allReadsStarted.ready,
        setTimeout(5_000, undefined, { signal, ref: false }).then(() => {
          throw new Error("Not all fixture reads started");
        }),
      ]);
      return { content: [], details: undefined };
    },
  });

  await connectReadPlugin(pi, {
    id: "codemode-cancellation-boundary",
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    setup(api) {
      api.addResolver({
        priority: -100,
        resolver: {
          id: "cancellation-boundary",
          async tryResolve(source, context) {
            if (!paths.has(source)) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  seen.add(source);
                  if (seen.size === paths.size) allReadsStarted.release();
                  if (source.startsWith("fixture:direct-")) {
                    await Promise.race([
                      scriptEnded.ready,
                      setTimeout(10_000, undefined, { signal: context.signal, ref: false }).then(
                        () => {
                          throw new Error(
                            "The script did not finish while the top-level reads were pending",
                          );
                        },
                      ),
                    ]);
                  } else {
                    // These calls reach the resolver before the JavaScript throw and honor their signal.
                    await allReadsStarted.ready;
                    await setTimeout(1_000, undefined, { signal: context.signal });
                  }
                  context.signal?.throwIfAborted();
                  return [{ type: "text", text: source.slice("fixture:".length) + "-payload" }];
                },
              },
            };
          },
        },
      });
    },
  });
}
