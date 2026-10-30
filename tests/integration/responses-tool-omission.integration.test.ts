import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, test } from "vitest";
import { requiredValue } from "pi-agent-invariant";
import { testArtifactsDir } from "pi-coding-agent-test";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { piRuntime } from "#capabilities/inventory.ts";
import { runProcess } from "#capabilities/sandbox.ts";

interface WireTool {
  name: string;
  strict?: boolean;
}
interface WireRequest {
  tools?: WireTool[];
  input: { type?: string; tools?: WireTool[] }[];
}

function declarations(request: WireRequest): WireTool[] {
  return [
    ...(request.tools ?? []),
    ...request.input
      .filter((item) => item.type === "additional_tools")
      .flatMap((item) => item.tools ?? []),
  ];
}

// Only the external service is replaced: Pi serializes and sends the actual Responses request.
test("Responses additional_tools keep IDE arguments optional through the real request hook", async () => {
  await withTempWorkspace(async (cwd) => {
    const agentDir = path.join(cwd, "agent");
    await mkdir(agentDir);
    await writeFile(path.join(cwd, "unwanted.txt"), "remove\n");
    const requests: WireRequest[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: string[] = [];
        request.setEncoding("utf8");
        for await (const chunk of request) {
          if (typeof chunk !== "string") throw new Error("Unexpected HTTP body chunk");
          chunks.push(chunk);
        }
        requests.push(JSON.parse(chunks.join("")) as (typeof requests)[number]);
        const call =
          requests.length === 1
            ? {
                id: "fc_search",
                call_id: "discover-stage",
                name: "tool_search",
                arguments: { query: "stage", limit: 1 },
              }
            : requests.length === 2
              ? {
                  id: "fc_delete",
                  call_id: "delete-file",
                  name: "delete",
                  arguments: { path: "unwanted.txt" },
                }
              : undefined;
        const events: Record<string, unknown>[] =
          call === undefined
            ? []
            : [
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: {
                    ...call,
                    type: "function_call",
                    arguments: JSON.stringify(call.arguments),
                  },
                },
              ];
        events.push({
          type: "response.completed",
          response: { id: `response-${requests.length}`, status: "completed", output: [] },
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      })().catch((error: unknown) => {
        response.writeHead(500);
        response.end(String(error));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      await writeFile(
        path.join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            "responses-fixture": {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "SYNTHETIC_NOT_A_CREDENTIAL",
              api: "openai-responses",
              models: [
                {
                  id: "fixture",
                  name: "Responses fixture",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 200000,
                  maxTokens: 256,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  compat: {
                    supportsAdditionalTools: true,
                    supportsMidConvoSystemMessages: true,
                    supportsStrictMode: false,
                  },
                },
              ],
            },
          },
        }),
      );
      const names = [
        "read",
        "bash",
        "write",
        "search",
        "diff",
        "replace",
        "insert",
        "delete",
        "copy",
        "move",
        "undo",
        "unstage",
        "debug",
      ];
      await writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({
          defaultTools: [...names, "tool_search"],
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
          path.resolve("src/pi-agent-ide.ts"),
          "-e",
          "builtin:tool-search",
          "--model",
          "responses-fixture/fixture",
          "--thinking",
          "off",
          "--pi-agent-ide-no-post-processing",
          "true",
          "--",
          "Discover Stage, then delete unwanted.txt.",
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
      const artifacts = path.join(testArtifactsDir(import.meta.filename), "responses-omission");
      await mkdir(artifacts, { recursive: true });
      await Promise.all([
        writeFile(path.join(artifacts, "requests.json"), JSON.stringify(requests, null, 2)),
        writeFile(path.join(artifacts, "stdout.jsonl"), result.stdout),
        writeFile(path.join(artifacts, "stderr.log"), result.stderr),
      ]);
      expect(result.timedOut).toBe(false);
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(requests).toHaveLength(3);
      const first = requiredValue(requests[0]);
      const second = requiredValue(requests[1]);
      expect(declarations(first).find((tool) => tool.name === "stage")).toBeUndefined();
      const discovered = second.input
        .filter((item) => item.type === "additional_tools")
        .flatMap((item) => item.tools ?? []);
      expect(discovered.find((tool) => tool.name === "stage")).toMatchObject({ strict: false });
      for (const [index, request] of requests.entries()) {
        const effective = declarations(request);
        for (const name of [...names, ...(index > 0 ? ["stage"] : [])])
          expect(
            effective.findLast((tool) => tool.name === name),
            name,
          ).toMatchObject({
            strict: false,
          });
      }
      const events = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as { type?: string; toolName?: string; isError?: boolean });
      expect(
        events.find(
          (event) => event.type === "tool_execution_end" && event.toolName === "tool_search",
        ),
      ).toMatchObject({ isError: false });
      expect(
        events.find((event) => event.type === "tool_execution_end" && event.toolName === "delete"),
      ).toMatchObject({ isError: false });
      await expect(readFile(path.join(cwd, "unwanted.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}, 60000);
