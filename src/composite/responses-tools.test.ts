import { expect, test } from "vitest";
import { preserveResponsesToolOmission } from "./responses-tools.js";

const ideNames = new Set(["delete", "diff", "search"]);

test("opts IDE function tools out of implicit Responses strictness without changing schemas", () => {
  const parameters = {
    type: "object",
    properties: { path: { type: "string" }, start: { type: "string" } },
    required: ["path"],
  };
  const payload = {
    model: "gpt-6-luna",
    tools: [{ type: "function", name: "delete", parameters }],
    input: [{ arguments: { path: "sample.txt" } }],
  };
  const result = preserveResponsesToolOmission(payload, ideNames);
  expect(result).toEqual({ ...payload, tools: [{ ...payload.tools[0], strict: false }] });
  expect(result).not.toBe(payload);
  expect(payload.tools[0]).not.toHaveProperty("strict");
  expect((result as typeof payload).tools[0]?.parameters).toBe(parameters);
  expect((result as typeof payload).input).toBe(payload.input);
});

test("keeps explicit strictness and unrelated tools unchanged", () => {
  for (const strict of [true, false, null]) {
    const payload = { tools: [{ type: "function", name: "delete", strict }] };
    expect(preserveResponsesToolOmission(payload, ideNames)).toBe(payload);
  }
  const payload = {
    tools: [
      { type: "function", name: "other_tool" },
      { type: "custom", name: "delete" },
      { type: "web_search" },
    ],
  };
  expect(preserveResponsesToolOmission(payload, ideNames)).toBe(payload);
});

test("preserves omitted fields and explicit zero, false, and empty values in the transcript", () => {
  const input = [
    { arguments: { before: { path: "a.txt" }, after: { path: "b.txt" } } },
    { arguments: { before: { path: "a.txt", limit: 0 }, after: { path: "b.txt", limit: 0 } } },
    { arguments: { query: "word", caseSensitive: false, include: "" } },
  ];
  const payload = { tools: [{ type: "function", name: "diff" }], input };
  expect(preserveResponsesToolOmission(payload, ideNames)).toEqual({
    ...payload,
    tools: [{ type: "function", name: "diff", strict: false }],
  });
  expect(input[0]?.arguments.before).not.toHaveProperty("limit");
  expect(input[1]?.arguments.before?.limit).toBe(0);
  expect(input[2]?.arguments.caseSensitive).toBe(false);
  expect(input[2]?.arguments.include).toBe("");
});

test("ignores payloads without function tools", () => {
  for (const payload of [undefined, null, [], "text", {}, { tools: null }, { tools: [] }])
    expect(preserveResponsesToolOmission(payload, ideNames)).toBe(payload);
});
