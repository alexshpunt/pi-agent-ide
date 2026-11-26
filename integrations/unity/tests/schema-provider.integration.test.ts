import { once } from "node:events";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, test } from "vitest";
import { pathToFileURL } from "node:url";

const { findRepositoryRoot } = (await import(
  pathToFileURL(path.resolve("scripts/repository-root.ts")).href
)) as {
  findRepositoryRoot: (url: string) => string;
};
const repository = findRepositoryRoot(import.meta.url);
const { withTempWorkspace } = (await import(
  pathToFileURL(path.join(repository, "tests/integration/support/pi-runtime/fixtures.ts")).href
)) as {
  withTempWorkspace: <T>(callback: (directory: string) => Promise<T>) => Promise<T>;
};
const { piRuntime } = (await import(
  pathToFileURL(path.join(repository, "benchmarks/tool-capabilities/inventory.ts")).href
)) as {
  piRuntime: () => Promise<{ cli: string }>;
};
const { runProcess } = (await import(
  pathToFileURL(path.join(repository, "benchmarks/tool-capabilities/sandbox.ts")).href
)) as {
  runProcess: (
    command: string,
    args: string[],
    options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
  ) => Promise<{ timedOut: boolean; code: number | null; stdout: string; stderr: string }>;
};

interface Schema {
  type?: string;
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
}
interface WireTool {
  name?: string;
  input_schema?: Schema;
  function?: { name: string; parameters: Schema };
}
interface WireRequest {
  tools?: WireTool[];
}

const project = "/projects/Fixture";
const calls = [
  {
    id: "discover",
    name: "unity_search",
    arguments: { path: `unity://project/${encodeURIComponent(project)}/tools`, query: "fixture" },
  },
  {
    id: "invoke",
    name: "unity_fixture_inspect",
    arguments: { project, arguments: { path: "Scene", recursive: true, limit: 3 } },
  },
];

// The HTTP server replaces the external provider only. Pi still serializes its real tool declarations.
test.each([
  { api: "anthropic-messages", id: "anthropic" },
  { api: "openai-completions", id: "openai" },
])(
  "$id receives Unity built-in and discovered fixture schemas",
  async ({ api }) => {
    await withTempWorkspace(async (cwd) => {
      const agentDir = path.join(cwd, "agent");
      const cli = path.join(cwd, "unity");
      await mkdir(agentDir);
      await copyFile(path.resolve("integrations/unity/tests/schema-cli.mjs"), cli);
      await chmod(cli, 0o755);
      const requests: WireRequest[] = [];
      const server = createServer((request, response) => {
        void (async () => {
          request.setEncoding("utf8");
          const chunks: string[] = [];
          for await (const chunk of request) {
            if (typeof chunk !== "string") throw Error("Unexpected request body");
            chunks.push(chunk);
          }
          requests.push(JSON.parse(chunks.join("")) as WireRequest);
          const call = calls.at(requests.length - 1);
          if (api === "openai-completions") {
            const chunk = {
              id: `completion_${requests.length}`,
              object: "chat.completion.chunk",
              created: 0,
              model: "fixture",
              choices: [
                {
                  index: 0,
                  delta: call
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: call.id,
                            type: "function",
                            function: {
                              name: call.name,
                              arguments: JSON.stringify(call.arguments),
                            },
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
              choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
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
              content_block: call
                ? { type: "tool_use", id: call.id, name: call.name, input: {} }
                : { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: call
                ? { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) }
                : { type: "text_delta", text: "complete" },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null },
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
              fixture: {
                baseUrl: `http://127.0.0.1:${address.port}`,
                apiKey: "SYNTHETIC_NOT_A_CREDENTIAL",
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
            defaultTools: ["unity_read", "unity_search", "unity_call", "unity_install_cli"],
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
            path.resolve("integrations/unity/src/index.ts"),
            "-e",
            path.resolve("integrations/unity/tests/schema-activate.ts"),
            "--model",
            "fixture/fixture",
            "--thinking",
            "off",
            "--",
            "Inspect the fixture.",
          ],
          {
            cwd,
            timeoutMs: 60000,
            env: {
              ...process.env,
              PI_CODING_AGENT_DIR: agentDir,
              PI_UNITY_CLI: cli,
              PI_OFFLINE: "1",
              PI_SKIP_VERSION_CHECK: "1",
            },
          },
        );
        expect(result.timedOut).toBe(false);
        expect(result.code, result.stderr || result.stdout).toBe(0);
        expect(requests).toHaveLength(3);
        const schemas = (request: WireRequest) =>
          new Map(
            (request.tools ?? []).map((tool) => [
              tool.function?.name ?? tool.name,
              tool.function?.parameters ?? tool.input_schema,
            ]),
          );
        const initial = schemas(requests[0]);
        const after = schemas(requests[1]);
        for (const [name, fields] of Object.entries({
          unity_read: ["path"],
          unity_search: ["query"],
          unity_call: ["project", "name", "arguments"],
          unity_install_cli: ["sshTarget"],
        })) {
          const schema = initial.get(name);
          expect(schema, `missing ${name}`).toBeDefined();
          for (const field of fields) expect(schema?.properties).toHaveProperty(field);
        }
        expect(initial.has("unity_fixture_inspect")).toBe(false);
        const dynamic = after.get("unity_fixture_inspect");
        expect(dynamic?.required).toEqual(expect.arrayContaining(["project", "arguments"]));
        const args = dynamic?.properties?.arguments;
        expect(args?.required).toContain("path");
        expect(args?.properties).toMatchObject({
          path: { type: "string" },
          recursive: { type: "boolean" },
          limit: { type: "integer", minimum: 1 },
        });
        expect(args?.additionalProperties).toBe(false);
        const events = result.stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map(
            (line) => JSON.parse(line) as { type?: string; toolName?: string; isError?: boolean },
          );
        for (const name of ["unity_search", "unity_fixture_inspect"]) {
          const execution = events.find(
            (event) => event.type === "tool_execution_end" && event.toolName === name,
          );
          expect(execution, `missing ${name} execution`).toBeDefined();
          expect(execution?.isError).toBe(false);
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  },
  90000,
);
