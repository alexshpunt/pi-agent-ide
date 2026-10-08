import { expect, test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TextEditorCore } from "#src/core/text-editor-core.js";
import { buildFailedTextMutationResult } from "#src/core/text-mutation.js";
import { FileMutationAgentResult } from "#src/core/mutation-result/file-mutation-agent-result.js";
import { FileMutationResult } from "#src/core/mutation-result/file-mutation-result.js";

const failure = {
  ok: false,
  path: "source.txt",
  errors: [{ path: "source.txt", code: "INTERNAL_ERROR", reason: "Execution failed" }],
};

test.each([
  { effect: "unknown" as const, statement: "effects are unknown" },
  { effect: "applied" as const, statement: "edit was saved" },
  { effect: "not-applied" as const, statement: "No file was changed" },
])("text failure preserves confirmed $effect evidence", async ({ effect, statement }) => {
  const result = await buildFailedTextMutationResult(
    Object.create(null) as TextEditorCore,
    { source: "source.txt", code: "PLUGIN_FAILED", message: "Execution failed" },
    Object.create(null) as ExtensionContext,
    effect,
  );
  expect(result.details.effect).toBe(effect);
  const output = result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
  expect(output).toContain(statement);
  if (effect !== "not-applied") expect(output).not.toContain("No file was changed");
});

test("a rejected peer does not claim that the whole batch stayed unchanged", async () => {
  const result = await buildFailedTextMutationResult(
    Object.create(null) as TextEditorCore,
    { source: "source.txt", code: "MUTATION_REJECTED", message: "This peer was rejected" },
    Object.create(null) as ExtensionContext,
    "not-applied",
  );
  const output = result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
  expect(result.details.effect).toBe("not-applied");
  expect(output).not.toContain("No file was changed");
});
test("a failed call without effect evidence does not claim unchanged files", () => {
  const output = new FileMutationAgentResult(new FileMutationResult(failure)).toText();
  expect(output).toContain("Execution failed");
  expect(output).not.toContain("No file was changed");
});

test.each([
  "No file was changed.",
  "Effects are unknown. Read source and destination before retrying.",
  "The edit was saved, but a post-write step failed.",
])("preserves an explicit effect statement: %s", (fileChangedStatement) => {
  const output = new FileMutationAgentResult(
    new FileMutationResult({ ...failure, fileChangedStatement }),
  ).toText();
  expect(output).toContain(fileChangedStatement);
  if (fileChangedStatement !== "No file was changed.")
    expect(output).not.toContain("No file was changed");
});
