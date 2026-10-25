import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.js";
import type { TextSemanticMutationResult } from "#src/api/mutation-tool.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { createTextTool } from "#src/core/text-mutation.js";
import { ToolCallInterceptionRenderStore } from "#src/core/tool-call-interceptor/rendering.js";
import { insertMutationTool } from "#src/tools/tool-text-insert.js";
import { deleteMutationTool } from "#src/tools/tool-text-delete.js";

const SOURCE = "probe:window";
const CROPS = [
  { type: "image" as const, data: "YmVmb3Jl", mimeType: "image/png" },
  { type: "image" as const, data: "YWZ0ZXI=", mimeType: "image/png" },
];

async function insertWith(action: Omit<TextSemanticMutationResult, "source">) {
  const core = createTextEditorCore();
  core.addMutationTool(insertMutationTool);
  await core.registerPlugin({
    id: "semantic-images",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addResolver({
        resolver: {
          id: "probe",
          async tryResolve(requested) {
            if (requested !== SOURCE) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source: SOURCE,
                async read() {
                  return [{ type: "text", text: "Probe ready" }];
                },
              },
            };
          },
        },
      });
      api.tool("insert").addSemanticHandler({
        matches: (input) => (input as { path?: string }).path === SOURCE,
        async execute() {
          return { source: SOURCE, ...action };
        },
      });
    },
  });
  const tool = createTextTool(
    core,
    insertMutationTool,
    new ToolCallInterceptionRenderStore(),
    () => undefined,
  );
  return tool.execute("insert-images", { path: SOURCE, text: "click" }, undefined, undefined, {
    cwd: process.cwd(),
  } as ExtensionToolContext);
}

test("a semantic action's images follow its summary in the tool content", async () => {
  const result = await insertWith({
    summary: "Clicked; the canvas changed.",
    data: { ok: true },
    script: { changed: true },
    images: CROPS,
  });
  expect(result.isError).not.toBe(true);
  expect(result.content).toEqual([
    { type: "text", text: "Clicked; the canvas changed." },
    ...CROPS,
  ]);
  // Image data stays out of the details; the script value is unchanged.
  expect(JSON.stringify(result.details)).not.toContain("YmVmb3Jl");
  expect(result.details.metadata?.semanticAction).toMatchObject({
    ok: true,
    source: SOURCE,
    script: { changed: true },
  });
});

test("a semantic action without images keeps text-only content", async () => {
  const result = await insertWith({ summary: "Clicked.", data: { ok: true } });
  expect(result.content).toEqual([{ type: "text", text: "Clicked." }]);
});

test("a direct action's images follow its summary too", async () => {
  const core = createTextEditorCore();
  const definition = {
    ...deleteMutationTool,
    direct: {
      matches: () => true,
      async execute() {
        return { source: SOURCE, summary: "Done.", data: { ok: true }, images: CROPS };
      },
    },
  };
  const tool = createTextTool(
    core,
    definition,
    new ToolCallInterceptionRenderStore(),
    () => undefined,
  );
  const result = await tool.execute("direct-images", { path: "unused" }, undefined, undefined, {
    cwd: process.cwd(),
  } as ExtensionToolContext);
  expect(result.content).toEqual([{ type: "text", text: "Done." }, ...CROPS]);
});
