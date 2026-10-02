import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL } from "pi-agent-read/api/plugin-protocol";
import { Type } from "typebox";

import registerStaleAnchor from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-stale-anchor/index.js";
import { processToolCallStreamEvent } from "#pi-agent-text-editor/core/tool-call-interceptor/coordinator.js";

/** Drive repeated stream inspections through the real interceptor without aborting the provider. */
export default async function registerBlockCacheProbe(pi: ExtensionAPI): Promise<void> {
  await registerStaleAnchor(pi);
  let reads = 0;
  let serial = 0;
  let verifyAgentEnd = false;
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "block-cache-probe",
    setup(api) {
      api.addHandler({
        stage: "post-read",
        handler(context) {
          if (context.request.path === "subject.txt") reads += 1;
          return { kind: "continue", context };
        },
      });
    },
  });

  async function start(context: ExtensionContext) {
    const call = {
      type: "toolCall" as const,
      id: `cache-${++serial}`,
      name: "insert",
      arguments: {},
    };
    const partial = { role: "assistant", content: [call] } as AssistantMessage;
    await processToolCallStreamEvent(
      pi,
      { type: "toolcall_start", contentIndex: 0, partial },
      context,
    );
    const blocked = await processToolCallStreamEvent(
      pi,
      {
        type: "toolcall_delta",
        contentIndex: 0,
        partial,
        delta: '{"path":"subject.txt","anchor":"1#AAAA","text":"unused"',
      },
      context,
    );
    if (!blocked) throw new Error("Expected a stale-anchor block");
    return { partial, call, blocked };
  }

  pi.registerTool({
    name: "probe_block_cache",
    label: "Block cache probe",
    description: "Checks repeated stale-anchor inspections and lifecycle cleanup.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, context) {
      const controller = new AbortController();
      const probeContext = { ...context, signal: controller.signal };
      const first = await start(probeContext);
      const afterFirst = reads;
      const repeated = await processToolCallStreamEvent(
        pi,
        {
          type: "toolcall_delta",
          contentIndex: 0,
          partial: first.partial,
          delta: " ",
        },
        probeContext,
      );
      const afterRepeat = reads;
      controller.abort();
      const second = await start(context);
      const afterAbort = reads;
      await processToolCallStreamEvent(
        pi,
        {
          type: "toolcall_end",
          contentIndex: 0,
          partial: second.partial,
          toolCall: {
            ...second.call,
            arguments: { path: "subject.txt", anchor: "1#AAAA", text: "unused" },
          },
        },
        context,
      );
      const afterContentEnd = reads;
      await start(context);
      const afterRestart = reads;
      verifyAgentEnd = true;
      const details = {
        afterFirst,
        afterRepeat,
        afterAbort,
        afterContentEnd,
        afterRestart,
        sameMessage: JSON.stringify(first.blocked.result) === JSON.stringify(repeated?.result),
      };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });

  // Registered after the real coordinator: agent_end must have cleared its per-content state.
  pi.on("agent_end", async (_event, context) => {
    if (!verifyAgentEnd) return;
    verifyAgentEnd = false;
    const before = reads;
    await start(context);
    await writeFile(
      path.join(context.cwd, "cache-agent-end.json"),
      JSON.stringify({ before, after: reads }),
    );
  });
}
