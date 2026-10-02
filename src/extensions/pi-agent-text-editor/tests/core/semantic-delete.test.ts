import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { createTextTool } from "#src/core/text-mutation.js";
import { ToolCallInterceptionRenderStore } from "#src/core/tool-call-interceptor/rendering.js";
import { deleteMutationTool } from "#src/tools/tool-text-delete.js";

for (const source of ["debug:123456789abc", "debug:123456789abc/breakpoint/123456789a"]) {
  test(`delete routes ${source} through its semantic handler`, async () => {
    const core = createTextEditorCore();
    core.addMutationTool(deleteMutationTool);
    let deleted = false;
    await core.registerPlugin({
      id: "debug-delete",
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      setup(api) {
        api.addResolver({
          resolver: {
            id: "debug-state",
            async tryResolve(requested) {
              if (requested !== source) return { kind: "not-handled" };
              return {
                kind: "resolved",
                resource: {
                  source,
                  async read() {
                    if (deleted) throw new Error("Debug resource unavailable");
                    return [{ type: "text", text: "Status: terminated" }];
                  },
                },
              };
            },
          },
        });
        api.tool("delete").addSemanticHandler({
          matches: (input) => (input as { path?: string }).path === source,
          async execute() {
            deleted = true;
            return { source, summary: `Deleted ${source}.`, data: { deleted: true } };
          },
        });
      },
    });
    const tool = createTextTool(
      core,
      deleteMutationTool,
      new ToolCallInterceptionRenderStore(),
      () => undefined,
    );
    const result = await tool.execute("delete-debug", { path: source }, undefined, undefined, {
      cwd: process.cwd(),
    } as ExtensionToolContext);
    expect(result.isError).not.toBe(true);
    expect(deleted).toBe(true);
    expect(
      result.content.some(
        (block) => block.type === "text" && block.text.includes(`Deleted ${source}.`),
      ),
    ).toBe(true);
  });
}

test("delete still removes an ordinary file without a semantic handler", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "semantic-delete-"));
  try {
    const file = path.join(cwd, "ordinary.txt");
    await writeFile(file, "ordinary file");
    const core = createTextEditorCore();
    core.addMutationTool(deleteMutationTool);
    const tool = createTextTool(
      core,
      deleteMutationTool,
      new ToolCallInterceptionRenderStore(),
      () => undefined,
    );
    const result = await tool.execute("delete-file", { path: file }, undefined, undefined, {
      cwd,
    } as ExtensionToolContext);
    expect(result.isError).not.toBe(true);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
