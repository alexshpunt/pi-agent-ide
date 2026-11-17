import { expect, test } from "vitest";
import { codemodeToolNameMappings, explainCodemodeToolNames } from "./codemode-tool-names.ts";

const names = new Set(["read", "bash", "write", "replace", "custom_probe"]);
const renamed = ["Read", "Bash", "Write", "CUSTOM_PROBE"];
const payload = () => ({
  model: "fixture",
  messages: [{ role: "user", content: "fixture request" }],
  tools: [
    { name: "codemode", description: "fixture description", input_schema: { type: "object" } },
    ...renamed.map((name) => ({ name, description: name, input_schema: { type: "object" } })),
    { name: "replace", description: "unchanged" },
    { name: "External", description: "not an IDE tool" },
  ],
});

const formats = [
  { name: "flat", wrap: (tools: unknown[]) => ({ tools }) },
  {
    name: "function-wrapped",
    wrap: (tools: unknown[]) => ({
      tools: tools.map((tool) => ({ type: "function", function: tool })),
    }),
  },
  {
    name: "Google",
    wrap: (tools: unknown[]) => ({ config: { tools: [{ functionDeclarations: tools }] } }),
  },
  {
    name: "Bedrock",
    wrap: (tools: unknown[]) => ({
      toolConfig: { tools: tools.map((tool) => ({ toolSpec: tool })) },
    }),
  },
  {
    name: "additional-tools",
    wrap: (tools: unknown[]) => ({ input: [{ type: "additional_tools", tools }] }),
  },
];

test.each(formats)(
  "derives mappings from the current $name payload, not the provider or prior model",
  ({ wrap }) => {
    const declarations = [{ name: "READ" }, { name: "codemode", description: "fixture" }];
    const renamedPayload = wrap(declarations);
    expect(codemodeToolNameMappings(renamedPayload, names)).toEqual([
      { displayed: "READ", canonical: "read" },
    ]);
    const result = explainCodemodeToolNames(renamedPayload, names);
    expect(result).not.toBe(renamedPayload);
    expect(JSON.stringify(result)).toContain("tools.read");
    expect(declarations[1]?.description).toBe("fixture");
    const canonicalPayload = wrap([{ name: "read" }, { name: "codemode", description: "fixture" }]);
    expect(codemodeToolNameMappings(canonicalPayload, names)).toEqual([]);
    expect(explainCodemodeToolNames(canonicalPayload, names)).toBe(canonicalPayload);
    expect(explainCodemodeToolNames(renamedPayload, names)).toEqual(result);
  },
);

test("maps only actual renamed IDE declarations to canonical script members", () => {
  expect(codemodeToolNameMappings(payload(), names)).toEqual([
    { displayed: "Read", canonical: "read" },
    { displayed: "Bash", canonical: "bash" },
    { displayed: "Write", canonical: "write" },
    { displayed: "CUSTOM_PROBE", canonical: "custom_probe" },
  ]);
  expect(codemodeToolNameMappings(payload(), new Set(["read"]))).toEqual([
    { displayed: "Read", canonical: "read" },
  ]);
});

test("adds fixture mapping values only to Codemode, preserving schemas and other payloads", () => {
  const original = payload();
  const result = explainCodemodeToolNames(original, names) as ReturnType<typeof payload>;
  expect(result).not.toBe(original);
  expect(result.messages).toBe(original.messages);
  expect(result.tools[0]?.input_schema).toBe(original.tools[0]?.input_schema);
  for (const [index, tool] of original.tools.entries()) {
    if (index > 0) expect(result.tools[index]).toBe(tool);
  }
  // These are generated fixture values, not the surrounding explanatory wording.
  for (const { displayed, canonical } of codemodeToolNameMappings(original, names)) {
    expect(result.tools[0]?.description).toContain(displayed);
    expect(result.tools[0]?.description).toContain(`tools.${canonical}`);
  }
  expect(original).toEqual(payload());
  expect(explainCodemodeToolNames(original, names)).toEqual(result);
});

test("keeps canonical requests and requests without native Codemode untouched", () => {
  for (const tools of [
    [{ name: "read" }, { name: "codemode", description: "fixture" }],
    [{ name: "Read" }],
    [{ name: "Read" }, { name: "codemode" }],
    [{ name: "Read" }, { name: "other_codemode", description: "fixture" }],
    [{ name: "External" }, { name: "codemode", description: "fixture" }],
  ]) {
    const original = { tools };
    expect(explainCodemodeToolNames(original, names)).toBe(original);
  }
});

test("ignores malformed declarations without inventing tools or mutating the request", () => {
  for (const original of [
    null,
    undefined,
    [],
    "fixture",
    {},
    { tools: null },
    { tools: [null, {}, { name: 1 }] },
  ]) {
    expect(codemodeToolNameMappings(original, names)).toEqual([]);
    expect(explainCodemodeToolNames(original, names)).toBe(original);
  }
  const original = payload();
  expect(explainCodemodeToolNames(original, new Set())).toBe(original);
});
