import { writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";

const original = "keep\nOLD\nlast\n";
const updated = "keep\nNEW\nlast\n";

function send(response: ServerResponse, data: Record<string, unknown>): void {
  response.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Exercises the installed Anthropic SDK and adapter, replacing only the HTTP service. */
export default async function anthropicStalePrefixProvider(pi: ExtensionAPI): Promise<void> {
  const requests: unknown[] = [];
  const abortedPrefixes: string[] = [];
  const sentPayloads: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const turn = requests.length;
      response.writeHead(200, { "content-type": "text/event-stream" });
      send(response, {
        type: "message_start",
        message: {
          id: `message-${turn}`,
          type: "message",
          role: "assistant",
          model: "fixture",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      // Keep a non-tool content block before the intercepted call.
      send(response, {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      send(response, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "fixture" },
      });
      send(response, { type: "content_block_stop", index: 0 });
      if (turn === 7) {
        send(response, {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        });
        send(response, { type: "message_stop" });
        response.end();
        return;
      }
      const prefix = turn === 2 || turn === 3;
      const stale = prefix || turn === 4;
      const id = prefix
        ? `stale-${turn}`
        : turn === 4
          ? "complete-stale"
          : turn === 1
            ? "replace"
            : turn === 5
              ? "malformed"
              : "recovered";
      const args = turn === 1
        ? { path: "note.txt", at: "OLD", text: "NEW" }
        : {
            path: "note.txt",
            after: formatLineHashAnchor(stale ? original : updated, 2),
            ...(turn === 4 && { text: "BLOCKED" }),
            // A leading line break makes the insertion its own line after the anchored line.
            ...(turn === 6 && { text: "\nRECOVERED" }),
          };
      send(response, {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id, name: turn === 1 ? "replace" : "insert", input: {} },
      });
      const delta = (partial_json: string) => send(response, {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json },
      });
      const finish = () => {
        send(response, { type: "content_block_stop", index: 1 });
        send(response, {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 1 },
        });
        send(response, { type: "message_stop" });
        response.end();
      };
      if (!prefix) {
        delta(JSON.stringify(args));
        finish();
        return;
      }
      delta(JSON.stringify(args).slice(0, -1) + ",");
      const timer = setTimeout(() => {
        timers.delete(timer);
        sentPayloads.push(id);
        delta('"text":"BLOCKED"}');
        finish();
      }, 750);
      timers.add(timer);
      response.on("close", () => {
        if (timers.delete(timer)) {
          clearTimeout(timer);
          abortedPrefixes.push(id);
        }
      });
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server port");
  pi.registerProvider("anthropic-stale-prefix-fixture", {
    api: "anthropic-messages",
    apiKey: "SYNTHETIC_FIXTURE_KEY",
    baseUrl: `http://127.0.0.1:${address.port}`,
    models: [{
      id: "fixture",
      name: "Anthropic prefix fixture",
      reasoning: false,
      input: ["text"],
      contextWindow: 200000,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  });
  pi.on("session_shutdown", (_event, context) => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    server.closeAllConnections();
    server.close();
    writeFileSync(
      path.join(context.cwd, "anthropic-prefix-state.json"),
      JSON.stringify({ requests, abortedPrefixes, sentPayloads }),
    );
  });
}
