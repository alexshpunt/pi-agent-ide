import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityPrompt, parallelCallFormat } from "./prompts.ts";
import type { CapabilityCase } from "./validation.ts";

for (const [api, expected] of [
  ["openai-responses", "responses"],
  ["openai-codex-responses", "responses"],
  ["azure-openai-responses", "responses"],
  ["openai-completions", "completions"],
  ["anthropic-messages", "anthropic"],
  ["google-generative-ai", "neutral"],
  ["custom-api", "neutral"],
  [undefined, "neutral"],
] as const) {
  void test(`selects the batching format for ${api ?? "an unavailable API"}`, () => {
    assert.equal(parallelCallFormat(api), expected);
  });
}

const fixture: CapabilityCase = {
  id: "fixture",
  capabilities: [],
  modes: ["direct", "codemode"],
  steps: [{ tool: "fixture_tool" }],
};

void test("passes the selected API to a dynamic case prompt", () => {
  const received: Array<string | undefined> = [];
  const task: CapabilityCase = {
    ...fixture,
    promptForApi: (api) => {
      received.push(api);
      return `fixture-payload-${api}`;
    },
  };
  for (const api of ["openai-responses", "anthropic-messages", undefined]) {
    assert.ok(capabilityPrompt(task, "direct", api).includes(`fixture-payload-${api}`));
  }
  assert.deepEqual(received, ["openai-responses", "anthropic-messages", undefined]);
});

void test("renders only steps required for the selected route", () => {
  const task: CapabilityCase = {
    ...fixture,
    prompt: "",
    steps: [
      { tool: "fixture_direct_discovery", modes: ["direct"] },
      { tool: "fixture_shared_operation" },
      { tool: "fixture_script_operation", modes: ["codemode"] },
    ],
  };
  for (const mode of task.modes) {
    const prompt = capabilityPrompt(task, mode);
    assert.ok(prompt.includes("fixture_shared_operation"));
    assert.equal(prompt.includes("fixture_direct_discovery"), mode === "direct");
    assert.equal(prompt.includes("fixture_script_operation"), mode === "codemode");
  }
});
void test("discovery is a direct-only route requirement without case-specific modes", () => {
  for (const step of [
    { tool: "tool_search" },
    { tool: "tool_search", discovers: ["fixture_shared_operation"] },
  ]) {
    const task = { ...fixture, steps: [step, { tool: "fixture_shared_operation" }] };
    assert.ok(capabilityPrompt(task, "direct").includes("tool_search"));
    assert.ok(!capabilityPrompt(task, "codemode").includes("tool_search"));
    assert.ok(capabilityPrompt(task, "codemode").includes("fixture_shared_operation"));
  }
});
void test("preserves ordinary case prompts on both routes", () => {
  for (const mode of fixture.modes) {
    assert.ok(
      capabilityPrompt(
        { ...fixture, prompt: "fixture-static-payload" },
        mode,
        "custom-api",
      ).includes("fixture-static-payload"),
    );
  }
});
