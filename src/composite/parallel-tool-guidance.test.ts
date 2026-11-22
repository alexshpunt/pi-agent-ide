import { expect, test } from "vitest";
import { parallelToolFamily } from "./parallel-tool-guidance.ts";

// API identifiers are the host's routing contract, independent of provider/model names.
test.each([
  ["openai-responses", "responses"],
  ["openai-codex-responses", "responses"],
  ["azure-openai-responses", "responses"],
  ["openai-completions", "completions"],
  ["anthropic-messages", "anthropic"],
  ["bedrock-converse-stream", "neutral"],
  ["google-generative-ai", "neutral"],
  ["google-vertex", "neutral"],
  ["mistral-conversations", "neutral"],
  ["pi-messages", "neutral"],
  ["custom-api", "neutral"],
  [undefined, "neutral"],
] as const)("routes %s to %s guidance", (api, family) => {
  expect(parallelToolFamily(api)).toBe(family);
});
