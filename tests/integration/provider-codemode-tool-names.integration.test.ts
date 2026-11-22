import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, test } from "vitest";
import { requiredValue } from "pi-agent-invariant";
import { testArtifactsDir } from "pi-coding-agent-test";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { piRuntime } from "#capabilities/inventory.ts";
import { runProcess } from "#capabilities/sandbox.ts";
import { codemodeToolNameMappings } from "#src/composite/codemode-tool-names.ts";

interface WireTool {
  name?: string;
  description?: string;
  function?: { name: string; description: string };
}
interface WireRequest {
  tools: WireTool[];
}

const code = `
const before = await tools.read({ path: "task.txt" });
const changed = await tools.replace({ path: "task.txt", at: "OLD", text: "NEW" });
const after = await tools.read({ path: changed });
await tools.write({ path: "note.txt", content: "saved\\n" });
const probe = await tools.bash({ command: "printf tool-name-probe" });
if (before.text !== "keep\\nOLD\\nlast\\n" || after.text !== "NEW\\n") throw Error("fixture selection differs: " + JSON.stringify({ before, after }));
text({ before, after, probe });
`;

// Replace only the external service: real serializers, request hooks and native Codemode run
// inside Pi. The completions fixture simulates a provider normalizing names before our hook.
test.each([
  { id: "oauth", api: "anthropic-messages", oauth: true },
  { id: "api-key", api: "anthropic-messages", oauth: false },
  { id: "completions-renamed", api: "openai-completions", oauth: false },
])(
  "$id keeps provider names and native script names distinct",
  async ({ id, api, oauth }) => {
    await withTempWorkspace(async (cwd) => {
      const agentDir = path.join(cwd, "agent");
      await mkdir(agentDir);
      await writeFile(path.join(cwd, "task.txt"), "keep\nOLD\nlast\n");
      const requests: WireRequest[] = [];
      const server = createServer((request, response) => {
        void (async () => {
          request.setEncoding("utf8");
          const chunks: string[] = [];
          for await (const chunk of request) {
            if (typeof chunk !== "string") throw Error("Unexpected HTTP body chunk");
            chunks.push(chunk);
          }
          requests.push(JSON.parse(chunks.join("")) as WireRequest);
          const first = requests.length === 1;
          if (api === "openai-completions") {
            const chunk = {
              id: `completion_${requests.length}`,
              object: "chat.completion.chunk",
              created: 0,
              model: "fixture",
              choices: [
                {
                  index: 0,
                  delta: first
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: "script",
                            type: "function",
                            function: { name: "codemode", arguments: JSON.stringify({ code }) },
                          },
                        ],
                      }
                    : { content: "complete" },
                  finish_reason: null,
                },
              ],
            };
            const stop = {
              ...chunk,
              choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }],
            };
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              [chunk, stop].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
                "data: [DONE]\n\n",
            );
            return;
          }
          const events = [
            {
              type: "message_start",
              message: {
                id: `msg_${requests.length}`,
                type: "message",
                role: "assistant",
                model: "fixture",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: first
                ? { type: "tool_use", id: "script", name: "codemode", input: {} }
                : { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: first
                ? { type: "input_json_delta", partial_json: JSON.stringify({ code }) }
                : { type: "text_delta", text: "complete" },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ];
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
          );
        })().catch((error: unknown) => {
          response.writeHead(500);
          response.end(String(error));
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw Error("Missing fixture address");
        await writeFile(
          path.join(agentDir, "models.json"),
          JSON.stringify({
            providers: {
              "provider-fixture": {
                baseUrl: `http://127.0.0.1:${address.port}`,
                apiKey: oauth
                  ? "sk-ant-oat-SYNTHETIC_NOT_A_CREDENTIAL"
                  : "SYNTHETIC_NOT_A_CREDENTIAL",
                api,
                models: [
                  {
                    id: "fixture",
                    name: "Fixture",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 200000,
                    maxTokens: 256,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          }),
        );
        await writeFile(
          path.join(agentDir, "settings.json"),
          JSON.stringify({
            defaultTools: ["read", "replace", "write", "bash", "codemode"],
            retry: { enabled: false, maxRetries: 0 },
          }),
        );
        const runtime = await piRuntime();
        const result = await runProcess(
          process.execPath,
          [
            runtime.cli,
            "--approve",
            "--offline",
            "--mode",
            "json",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-context-files",
            "--no-prompt-templates",
            "--no-themes",
            "--no-mcp",
            "-e",
            path.resolve("tests/integration/fixtures/renamed-completions-tools.ts"),
            "-e",
            path.resolve("src/pi-agent-ide.ts"),
            "-e",
            "builtin:codemode",
            "--model",
            "provider-fixture/fixture",
            "--thinking",
            "off",
            "--pi-agent-ide-no-post-processing",
            "true",
            "--",
            "Run the fixture script.",
          ],
          {
            cwd,
            timeoutMs: 45000,
            env: {
              ...process.env,
              PI_CODING_AGENT_DIR: agentDir,
              PI_OFFLINE: "1",
              PI_SKIP_VERSION_CHECK: "1",
              PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "1",
            },
          },
        );
        const artifacts = path.join(testArtifactsDir(import.meta.filename), id);
        await mkdir(artifacts, { recursive: true });
        await Promise.all([
          writeFile(path.join(artifacts, "requests.json"), JSON.stringify(requests, null, 2)),
          writeFile(path.join(artifacts, "stdout.jsonl"), result.stdout),
          writeFile(path.join(artifacts, "stderr.log"), result.stderr),
        ]);
        expect(result.timedOut).toBe(false);
        expect(result.code, result.stderr || result.stdout).toBe(0);
        expect(requests).toHaveLength(2);
        const names = new Set(["read", "bash", "write", "replace"]);
        const expected =
          oauth || api === "openai-completions"
            ? [
                ...["read", "bash", "write"].map((canonical) => ({
                  displayed: oauth
                    ? canonical[0]?.toUpperCase() + canonical.slice(1)
                    : canonical.toUpperCase(),
                  canonical,
                })),
              ]
            : [];
        for (const request of requests) {
          const mappings = codemodeToolNameMappings(request, names);
          expect(mappings.sort((a, b) => a.canonical.localeCompare(b.canonical))).toEqual(
            [...expected].sort((a, b) => a.canonical.localeCompare(b.canonical)),
          );
          const description = requiredValue(
            request.tools
              .map((tool) => tool.function ?? tool)
              .find((tool) => tool.name === "codemode"),
          ).description;
          for (const { displayed, canonical } of expected) {
            expect(description).toContain(displayed);
            expect(description).toContain(`tools.${canonical}`);
          }
        }
        const events = result.stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map(
            (line) =>
              JSON.parse(line) as {
                type?: string;
                toolName?: string;
                isError?: boolean;
                result?: unknown;
              },
          );
        const execution = requiredValue(
          events.find(
            (event) => event.type === "tool_execution_end" && event.toolName === "codemode",
          ),
        );
        expect(execution.isError, JSON.stringify(execution.result)).toBe(false);
        expect(JSON.stringify(execution.result)).toContain("tool-name-probe");
        expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("keep\nNEW\nlast\n");
        expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("saved\n");
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  },
  60000,
);
