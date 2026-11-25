import test from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { rm } from "node:fs/promises";

import { registerLinearExtension } from "#axi/extension.ts";

type Dispatcher = NonNullable<Parameters<typeof registerLinearExtension>[2]>;
type RegisteredTool = {
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
};

function register(dispatch: Dispatcher) {
  let tool: RegisteredTool | undefined;
  let closed = false;
  const pi: Parameters<typeof registerLinearExtension>[0] = {
    registerTool: (definition) => {
      tool = definition as RegisteredTool;
      return definition;
    },
  };

  registerLinearExtension(
    pi,
    async (context) => ({
      ...context,
      mcpUrl: "https://example.test/mcp",
      client: {
        listTools: async () => [],
        callTool: async () => ({}),
        close: async () => {
          closed = true;
        },
      },
    }),
    dispatch,
  );
  if (!tool) throw new Error("linear_axi tool was not registered");
  return { tool, closed: () => closed };
}

void test("registers a pi tool that forwards linear-axi arguments and closes the client", async () => {
  let received;
  const extension = register(async (args) => {
    received = args;
    return { issues: [{ id: "LIN-123", title: "Fix auth" }] };
  });

  const result = await extension.tool.execute(
    "call-1",
    { action: "issues", args: ["list", "--assignee", "me"] },
    undefined,
    undefined,
    { cwd: "/tmp/project", sessionManager: { getSessionId: () => "fixture-session" } },
  );

  assert.deepEqual(received, ["issues", "list", "--assignee", "me"]);
  assert.match(result.content[0].text, /LIN-123/);
  assert.equal(extension.closed(), true);
});

void test("maps the dashboard action to the no-argument command", async () => {
  let received;
  const extension = register(async (args) => {
    received = args;
    return "project: Roadmap";
  });

  await extension.tool.execute("call-2", { action: "dashboard" }, undefined, undefined, {
    cwd: "/tmp/project",
    sessionManager: { getSessionId: () => "fixture-session" },
  });

  assert.deepEqual(received, []);
});

void test("uses manual OAuth login because pi tools cannot stream the browser URL", async () => {
  let received;
  const extension = register(async (args) => {
    received = args;
    return "auth: required";
  });

  await extension.tool.execute(
    "call-3",
    { action: "auth", args: ["login"] },
    undefined,
    undefined,
    { cwd: "/tmp/project", sessionManager: { getSessionId: () => "fixture-session" } },
  );

  assert.deepEqual(received, ["auth", "login", "--manual"]);
});

void test("closes the client and returns a normalized error when dispatch fails", async () => {
  const extension = register(async () => {
    throw new Error("request failed");
  });

  await assert.rejects(
    extension.tool.execute("call-4", { action: "issues", args: ["list"] }, undefined, undefined, {
      cwd: "/tmp/project",
      sessionManager: { getSessionId: () => "fixture-session" },
    }),
    /error: request failed/,
  );
  assert.equal(extension.closed(), true);
});

void test("saves oversized pi tool output to a temporary file", async () => {
  const extension = register(async () => `issues: ${"x".repeat(60_000)}`);
  const result = await extension.tool.execute(
    "call-5",
    { action: "issues" },
    undefined,
    undefined,
    { cwd: "/tmp/project", sessionManager: { getSessionId: () => "fixture-session" } },
  );
  const text = result.content[0].text;
  const outputPath = /Full output saved to: (.+)]$/.exec(text)?.[1];

  assert.match(text, /Output truncated/);
  assert.ok(outputPath);
  await rm(dirname(outputPath), { recursive: true, force: true });
});
