#!/usr/bin/env node
// Deterministic Unity CLI and MCP transport used by schema integration tests.
import { createInterface } from "node:readline";
import process from "node:process";

if (process.argv[2] === "status") {
  console.log(
    JSON.stringify({
      success: true,
      data: {
        instances: [{ projectPath: "/projects/Fixture", pid: 42, port: 1234, state: "ready" }],
      },
    }),
  );
} else if (process.argv[2] === "mcp") {
  const inputSchema = {
    type: "object",
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean" },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  };
  for await (const line of createInterface({ input: process.stdin })) {
    const message =
      /** @type {{ id?: number | string, method?: string, params: { protocolVersion?: string, arguments?: unknown } }} */ (
        JSON.parse(line)
      );
    if (message.id === undefined) continue;
    let result;
    if (message.method === "initialize")
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    else if (message.method === "tools/list")
      result = {
        tools: [{ name: "fixture_inspect", description: "Inspect fixture", inputSchema }],
      };
    else if (message.method === "tools/call")
      result = { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] };
    else {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unsupported method" },
        }) + "\n",
      );
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
} else {
  console.log(JSON.stringify({ success: true, data: { items: [] } }));
}
