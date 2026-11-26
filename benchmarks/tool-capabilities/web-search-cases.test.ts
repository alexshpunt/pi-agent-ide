import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type RunEvent } from "./validation.ts";

function events(
  calls: { tool: string; args: Record<string, unknown>; text: string }[],
  mode: string,
): RunEvent[] {
  const rows: RunEvent[] = calls.flatMap((call, index) => [
    {
      type: "tool_execution_start",
      toolCallId: String(index),
      toolName: call.tool,
      args: call.args,
      ...(mode === "codemode" ? { parentToolCallId: "script" } : {}),
    },
    {
      type: "tool_execution_end",
      toolCallId: String(index),
      toolName: call.tool,
      isError: false,
      result: { content: [{ type: "text", text: call.text }] },
    },
  ]);
  return mode === "direct"
    ? rows
    : [
        { type: "tool_execution_start", toolCallId: "script", toolName: "codemode", args: {} },
        ...rows,
        { type: "tool_execution_end", toolCallId: "script", toolName: "codemode", isError: false },
      ];
}
for (const mode of ["direct", "codemode"]) {
  void test(`web search route requires reusing the returned resource (${mode})`, () => {
    const task = capabilityCases.find((item) => item.id === "web-search-resource");
    assert.ok(task);
    const search = {
      tool: "web_search",
      args: { query: "fixture search", limit: 10 },
      text: "websearch:issued",
    };
    const read = {
      tool: "read",
      args: { path: "websearch:issued", offset: 11, limit: 2 },
      text: "Result 11",
    };
    const find = {
      tool: "search",
      args: { path: "websearch:issued", query: "r/12" },
      text: "Result 12",
    };
    assert.ok(validateRoute(task, events([search, read, find], mode), mode).passed);
    assert.ok(
      !validateRoute(
        task,
        events([search, { ...read, args: { ...read.args, path: "websearch:other" } }, find], mode),
        mode,
      ).passed,
    );
    assert.ok(!validateRoute(task, events([read, search, find], mode), mode).passed);
  });
  void test(`image route requires the issued resource (${mode})`, () => {
    const task = capabilityCases.find((item) => item.id === "image-search-resource");
    assert.ok(task);
    const image = {
      tool: "image_search",
      args: { query: "fixture image", limit: 2 },
      text: "websearch:image",
    };
    const read = {
      tool: "read",
      args: { path: "websearch:image", offset: 95, limit: 2 },
      text: "https://img.example/95.jpg",
    };
    assert.ok(validateRoute(task, events([image, read], mode), mode).passed);
    assert.ok(
      !validateRoute(
        task,
        events([image, { ...read, args: { ...read.args, path: "websearch:other" } }], mode),
        mode,
      ).passed,
    );
  });
}
