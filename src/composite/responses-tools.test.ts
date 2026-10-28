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

test("relaxes IDE declarations in additional_tools without modifying other input items", () => {
  const parameters = { type: "object", properties: { start: { type: "string" } } };
  const declaration = { type: "function", name: "delete", parameters };
  const explicit = {
    type: "additional_tools",
    tools: [{ type: "function", name: "diff", strict: true }],
  };
  const message = { role: "user", content: "delete the file", tools: [declaration] };
  const payload = {
    input: [
      message,
      { type: "additional_tools", role: "developer", tools: [declaration] },
      explicit,
      { type: "additional_tools", tools: [{ type: "function", name: "search" }] },
    ],
  };
  const result = preserveResponsesToolOmission(payload, ideNames) as typeof payload;
  expect(result).toEqual({
    input: [
      message,
      { ...payload.input[1], tools: [{ ...declaration, strict: false }] },
      explicit,
      { ...payload.input[3], tools: [{ type: "function", name: "search", strict: false }] },
    ],
  });
  expect(result.input[0]).toBe(message);
  expect(result.input[2]).toBe(explicit);
  expect(result.input[1]?.tools[0]).toHaveProperty("parameters", parameters);
  expect(declaration).not.toHaveProperty("strict");
  expect(payload.input[3]?.tools[0]).not.toHaveProperty("strict");
});

test("relaxes both declaration locations in a mixed request", () => {
  const payload = {
    tools: [{ type: "function", name: "diff" }],
    input: [{ type: "additional_tools", tools: [{ type: "function", name: "delete" }] }],
  };
  expect(preserveResponsesToolOmission(payload, ideNames)).toEqual({
    tools: [{ type: "function", name: "diff", strict: false }],
    input: [
      { type: "additional_tools", tools: [{ type: "function", name: "delete", strict: false }] },
    ],
  });
});

test("returns unchanged additional_tools requests by identity", () => {
  for (const tools of [
    null,
    [],
    [
      null,
      "text",
      {},
      { type: "function", name: 1 },
      { type: "function", name: "external" },
      { type: "custom", name: "delete" },
      ...[true, false, null].map((strict) => ({ type: "function", name: "delete", strict })),
    ],
  ]) {
    const payload = { input: [null, "text", {}, { type: "additional_tools", tools }] };
    expect(preserveResponsesToolOmission(payload, ideNames)).toBe(payload);
  }
});
test("ignores payloads without function tools", () => {
  for (const payload of [undefined, null, [], "text", {}, { tools: null }, { tools: [] }])
    expect(preserveResponsesToolOmission(payload, ideNames)).toBe(payload);
});
