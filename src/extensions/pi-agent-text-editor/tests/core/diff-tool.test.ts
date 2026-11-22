import { expect, test } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ReadPluginApi } from "pi-agent-read/api/plugin-protocol";
import { comparisonText, registerDiff } from "#src/core/diff-tool.ts";
import { createUnifiedDiff } from "#src/core/mutation-result/diff.ts";
import type { TextEditorCore } from "#src/core/text-editor-core.ts";

test("comparison text retains every resolved resource without parsing presentation", () => {
  const value = comparisonText(
    {
      kind: "resources",
      resources: [
        {
          kind: "text",
          source: "one",
          content: "a\r\n",
          lines: [],
          startLine: 1,
          endLine: 1,
          totalLines: 1,
        },
        {
          kind: "text",
          source: "two",
          content: "b",
          lines: [],
          startLine: 1,
          endLine: 1,
          totalLines: 1,
        },
      ],
    },
    "selection",
  );
  expect(value.content).toBe("a\r\n\nb");
  expect(value.sources).toEqual(["one", "two"]);
});

test("comparison refuses native image data rather than treating it as empty text", () => {
  expect(() =>
    comparisonText(
      {
        kind: "native",
        source: "image.png",
        blocks: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      },
      "image.png",
    ),
  ).toThrow(expect.objectContaining({ code: "UNSUPPORTED_CONTENT" }));
});

test("a truncated direct diff saves the complete diff and names its temporary result", async () => {
  let tool: ToolDefinition | undefined;
  const pi: Partial<ExtensionAPI> = {
    registerTool: (definition) => {
      tool = definition as ToolDefinition;
    },
  };
  const saved: string[] = [];
  // Longer than the 2000 lines a direct call shows.
  const rows = Array.from({ length: 2205 }, (_, index) => `row ${index}\n`).join("");
  const contents = new Map([
    ["before.txt", "head\n"],
    ["after.txt", `head\n${rows}`],
  ]);
  const read: Partial<ReadPluginApi> = {
    read: async ({ path = "" }) => ({
      content: [],
      details: {},
      script: {
        kind: "text",
        source: path,
        content: contents.get(path) ?? "",
        lines: [],
        startLine: 1,
        endLine: 1,
        totalLines: 1,
      },
    }),
    saveTemporary: async (text) => {
      saved.push(text);
      return "temp:full-diff";
    },
  };
  registerDiff(pi as ExtensionAPI, {} as TextEditorCore, () => read as ReadPluginApi);
  const result = await tool?.execute(
    "diff",
    { before: "before.txt", after: "after.txt" },
    undefined,
    undefined,
    { cwd: process.cwd() } as Parameters<ToolDefinition["execute"]>[4],
  );
  const { diff } = createUnifiedDiff("before.txt", "head\n", `head\n${rows}`, "after.txt");
  expect(saved).toEqual([diff]);
  const [shown] = result?.content ?? [];
  expect(shown?.type === "text" && shown.text).toMatch(
    /\nDiff output is truncated; [^\n]+\nUse read with path "temp:full-diff" for the full diff\.$/u,
  );
});
