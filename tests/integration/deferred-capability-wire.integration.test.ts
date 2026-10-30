import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
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
  description?: string;
  parameters?: { properties?: { path?: { description?: string } } };
}
interface WireItem {
  type?: string;
  tools?: WireTool[];
}
interface WireRequest {
  input: WireItem[];
}
interface ExecutionEvent {
  type?: string;
  toolName?: string;
  isError?: boolean;
  result?: { content?: { type: string; text?: string }[] };
}

// Only the external service is replaced; the actual Pi/Responses serializer sends these requests.
test("Responses append capability parameter redefinitions without changing the earlier request prefix", async () => {
  await withTempWorkspace(async (cwd) => {
    const marker = "fixture-capability-alpha";
    const fileContent = "wire-capability-resource-content";
    const agentDir = path.join(cwd, "agent");
    await mkdir(agentDir);
    await writeFile(path.join(cwd, "example.txt"), `${fileContent}\n`);
    const requests: WireRequest[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: string[] = [];
        request.setEncoding("utf8");
        for await (const chunk of request) {
          if (typeof chunk !== "string") throw new Error("Unexpected HTTP body chunk");
          chunks.push(chunk);
        }
        requests.push(JSON.parse(chunks.join("")) as WireRequest);
        const call =
          requests.length === 1
            ? { name: "tool_search", arguments: { query: "ide_capability_alpha", limit: 1 } }
            : requests.length === 2
              ? { name: "read", arguments: { path: "example.txt" } }
              : undefined;
        const events: Record<string, unknown>[] =
          call === undefined
            ? []
            : [
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: {
                    type: "function_call",
                    id: `fc_${requests.length}`,
                    call_id: `call-${requests.length}`,
                    name: call.name,
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
            "capability-wire-fixture": {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "SYNTHETIC_NOT_A_CREDENTIAL",
              api: "openai-responses",
              models: [
                {
                  id: "fixture",
                  name: "Capability wire fixture",
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
      await writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({
          defaultTools: ["+read", "+tool_search"],
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
          path.resolve("tests/integration/fixtures/deferred-capabilities.ts"),
          "-e",
          "builtin:tool-search",
          "--model",
          "capability-wire-fixture/fixture",
          "--thinking",
          "off",
          "--pi-agent-ide-no-post-processing",
          "true",
          "--",
          "Discover the fixture capability and read example.txt.",
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
      const artifacts = path.join(testArtifactsDir(import.meta.filename), "responses-capabilities");
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
      const initialRead = requiredValue(
        first.input
          .filter((item) => item.type === "additional_tools")
          .flatMap((item) => item.tools ?? [])
          .find((tool) => tool.name === "read"),
      );
      expect(initialRead.description).not.toContain(marker);
      expect(initialRead.parameters?.properties?.path?.description).not.toContain(marker);
      expect(second.input.slice(0, first.input.length)).toEqual(first.input);
      const newDeclarations = second.input
        .slice(first.input.length)
        .filter((item) => item.type === "additional_tools")
        .flatMap((item) => item.tools ?? []);
      const revisedRead = requiredValue(newDeclarations.find((tool) => tool.name === "read"));
      expect(revisedRead.description).toContain(marker);
      expect(revisedRead.parameters?.properties?.path?.description).toContain(marker);
      const third = requiredValue(requests[2]);
      expect(third.input.slice(0, second.input.length)).toEqual(second.input);
      const events = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as ExecutionEvent);
      const readResult = requiredValue(
        events.find((event) => event.type === "tool_execution_end" && event.toolName === "read"),
      );
      expect(readResult.isError).toBe(false);
      expect(
        readResult.result?.content
          ?.filter((item) => item.type === "text")
          .map((item) => item.text ?? "")
          .join("\n"),
      ).toContain(fileContent);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}, 60000);
