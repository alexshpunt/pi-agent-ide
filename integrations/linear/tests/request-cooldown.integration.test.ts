import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";
interface RequestCounts extends Record<string, number> {
  toolsList: number;
  workspace: number;
  project: number;
  httpRequests: number;
  mutations: number;
  mutationAttempts: number;
}
interface McpFixture {
  directory: string;
  environment: Record<
    | "LINEAR_AXI_CONNECTION_FILE"
    | "LINEAR_AXI_MCP_URL"
    | "LINEAR_AXI_GRAPHQL_URL"
    | "LINEAR_AXI_CONNECTION_ID",
    string
  >;
  workspace: string;
  projectId: string;
  snapshot(): RequestCounts;
  rateLimitNext(): void;
  rateLimitResetAt(): number;
  close(): Promise<void>;
}

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const control = (id: string, action: "select-work" | "snapshot" | "arm") =>
  assistantMessage([toolCall({ id, name: "request_cooldown_control", arguments: { action } })], {
    stopReason: "toolUse",
  });
const read = (id: string, source: string) =>
  assistantMessage([toolCall({ id, name: "read", arguments: { path: source } })], {
    stopReason: "toolUse",
  });

// Pattern: packaged-axi.integration.test.ts and the package extension example.
// Contract: actual Pi, provider and CLI reuse preflight proof but never a resource result,
// and safe rate timing crosses both the agent result and native TUI without another request.
test("real Pi reuses Linear preflight and suppresses HTTP after a server cooldown", async () => {
  const ide = await currentIde();
  // A variable import keeps the backend's separate compiler settings out of the frontend project.
  const fixturePath = path.join(root, "packages/linear-axi/test/fixtures/mcp-request-count.ts");
  const { createMcpRequestCountFixture, PRIVATE_RATE_LIMIT_BODY } = (await import(fixturePath)) as {
    createMcpRequestCountFixture(): Promise<McpFixture>;
    PRIVATE_RATE_LIMIT_BODY: string;
  };
  const mcp = await createMcpRequestCountFixture();
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request as AsyncIterable<Buffer>) {
        length += chunk.byteLength;
        if (length > 4096) throw Error("REQUEST_COOLDOWN_CONTROL_TOO_LARGE");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { action?: unknown };
      if (input.action === "arm") mcp.rateLimitNext();
      else if (input.action !== "snapshot") {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ counts: mcp.snapshot() }));
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "REQUEST_COOLDOWN_CONTROL_FAILED" }));
    }
  };
  const http = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", resolve);
    });
    const address = http.address();
    if (!address || typeof address === "string")
      throw Error("REQUEST_COOLDOWN_CONTROL_NOT_LISTENING");
    const cwd = mcp.directory;
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(
      path.join(cwd, ".pi/linear.json"),
      JSON.stringify({
        axiPath: path.join(root, "packages/linear-axi/dist/bin.js"),
      }),
    );
    const envFile = path.join(cwd, "empty.env");
    await writeFile(envFile, "");
    const source = `linear://${mcp.workspace}/project/${mcp.projectId}`;
    const result = await new PiIntegrationTest({
      testName: "linear-request-cooldown",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      tuiSize: { cols: 110, rows: 60 },
      timeoutMs: 90000,
      extensions: [ide.extension, path.join(root, "tests/fixtures/request-cooldown-proof.ts")],
      tools: ["read", "request_cooldown_control"],
      environment: {
        HOME: path.join(cwd, "home"),
        XDG_CONFIG_HOME: path.join(cwd, "config"),
        LINEAR_AXI_CONNECTION_FILE: mcp.environment.LINEAR_AXI_CONNECTION_FILE,
        LINEAR_AXI_MCP_URL: mcp.environment.LINEAR_AXI_MCP_URL,
        LINEAR_AXI_GRAPHQL_URL: mcp.environment.LINEAR_AXI_GRAPHQL_URL,
        LINEAR_AXI_ENV_FILE: envFile,
        LINEAR_TEST_REQUEST_COOLDOWN_CONTROL: `http://127.0.0.1:${address.port}/control`,
      },
      conversation: [
        control("select-work", "select-work"),
        read("cold", source),
        control("after-cold", "snapshot"),
        read("warm", source),
        control("after-warm", "snapshot"),
        control("arm", "arm"),
        read("limited", source),
        control("after-limit", "snapshot"),
        read("blocked", source),
        control("after-block", "snapshot"),
        assistantMessage([text("The isolated request checks completed.")]),
      ],
    }).run(
      "Select the saved synthetic Work connection. Read the local fixture project twice, then observe one rate limit and one cooldown rejection. Do not use real Linear or another account.",
    );
    await ide.record(result.artifacts.directory);
    expect(result.exitCode).toBe(0);
    expect(getToolExecution(result, "select-work").isError).toBe(false);
    expect(JSON.parse(getToolResultText(result, "select-work"))).toMatchObject({
      selection: { connectionId: mcp.environment.LINEAR_AXI_CONNECTION_ID },
    });
    for (const id of ["cold", "warm"]) {
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      expect(getToolResultText(result, id)).toContain(mcp.projectId);
    }
    const counts = (id: string): RequestCounts => {
      expect(getToolExecution(result, id).isError).toBe(false);
      const receipt = JSON.parse(getToolResultText(result, id)) as { counts: RequestCounts };
      return receipt.counts;
    };
    const cold = counts("after-cold");
    const warm = counts("after-warm");
    const limited = counts("after-limit");
    const blocked = counts("after-block");
    await writeFile(
      path.join(result.artifacts.directory, "request-counts.json"),
      JSON.stringify({ cold, warm, limited, blocked }, null, 2),
    );
    expect(cold.toolsList).toBe(1);
    expect(cold.workspace).toBe(1);
    expect(cold.project).toBe(1);
    expect(warm.toolsList).toBe(cold.toolsList);
    expect(warm.workspace).toBe(cold.workspace);
    expect(warm.project).toBe(cold.project + 1);
    expect(limited.project).toBe(warm.project + 1);
    expect(blocked).toEqual(limited);
    expect(blocked.mutations).toBe(0);
    expect(blocked.mutationAttempts).toBe(0);
    const rate = (id: string) => {
      expect(getToolExecution(result, id).isError).toBe(true);
      const entry = result.traceEvents.find(
        (value) =>
          value.type === "tool_result" &&
          (value.event as { toolCallId?: string } | undefined)?.toolCallId === id,
      );
      if (!entry) throw new Error(`Missing result for ${id}: ${getToolResultText(result, id)}`);
      // The trace records the original result before tool_result hooks add guidance.
      const actual = entry.event as {
        structuredContent?: {
          errors?: {
            code?: string;
            metadata?: { rateLimit?: { retryAfterMs?: number; resetAt?: number } };
          }[];
        };
      };
      const error = actual.structuredContent?.errors?.find(
        (value) => value.code === "LINEAR_OPERATION_RATE_LIMITED",
      );
      const limit = error?.metadata?.rateLimit;
      const { retryAfterMs, resetAt } = limit ?? {};
      if (retryAfterMs === undefined || resetAt === undefined) {
        throw new Error(`Missing rate timing for ${id}: ${getToolResultText(result, id)}`);
      }
      expect(retryAfterMs).toBeGreaterThan(0);
      expect(retryAfterMs).toBeLessThanOrEqual(60000);
      expect(resetAt).toBeGreaterThan(mcp.rateLimitResetAt() - 2000);
      expect(getToolResultText(result, id)).toContain(new Date(resetAt).toISOString());
      return { retryAfterMs, resetAt };
    };
    const firstRate = rate("limited");
    const laterRate = rate("blocked");
    expect(firstRate.retryAfterMs).toBe(60000);
    expect(laterRate.resetAt).toBe(firstRate.resetAt);
    expect(getToolResultText(result, "limited")).toContain("60");
    expect(getToolResultText(result, "limited")).toContain(
      new Date(firstRate.resetAt).toISOString(),
    );
    expect(result.tuiRenderedOutput.replaceAll(/\s/gu, "")).toContain(
      new Date(firstRate.resetAt).toISOString(),
    );
    for (const value of [
      JSON.stringify(result.messages),
      result.terminalOutput,
      result.tuiRenderedOutput,
    ]) {
      expect(value).not.toContain(PRIVATE_RATE_LIMIT_BODY);
      expect(value).not.toContain("synthetic-request-count-key");
    }
  } finally {
    http.closeAllConnections();
    if (http.listening)
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    await mcp.close();
  }
}, 120000);
