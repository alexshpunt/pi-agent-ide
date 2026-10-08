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
import { replaceMutationTool } from "#src/tools/tool-text-replace.js";
import { executeRegisteredTextBatch } from "#src/core/text-edit-batch-registrar.js";
import { BatchExecutionJournal } from "#src/core/text-edit-batch-execution.js";

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

for (const effect of ["applied", "not-applied", "unknown"] as const) {
  test(`direct mutation failure preserves the owner's ${effect} effect`, async () => {
    const core = createTextEditorCore();
    const definition = {
      ...deleteMutationTool,
      direct: {
        matches: () => true,
        async execute() {
          throw Object.assign(new Error("Owner cleanup failed"), {
            code: "CLEANUP_FAILED",
            effect,
          });
        },
      },
    };
    const tool = createTextTool(
      core,
      definition,
      new ToolCallInterceptionRenderStore(),
      () => undefined,
    );
    const result = await tool.execute("direct-effect", { path: "unused" }, undefined, undefined, {
      cwd: process.cwd(),
    } as ExtensionToolContext);
    expect(result.details).toMatchObject({ effect });
    const output = result.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    if (effect === "not-applied") expect(output).toContain("No file was changed.");
    else expect(output).not.toContain("No file was changed.");
    expect(
      result.content.some(
        (block) => block.type === "text" && block.text.includes("Owner cleanup failed"),
      ),
    ).toBe(true);
  });
}

for (const effect of ["not-applied", "applied", "unknown"] as const) {
  test(`post-write failure keeps completed text and reports the aggregate ${effect} effect`, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "post-write-effect-"));
    const core = createTextEditorCore();
    try {
      const file = path.join(cwd, "note.txt");
      await writeFile(file, "before");
      await core.registerPlugin({
        id: "post-write-file-owner",
        protocol: TEXT_EDITOR_PROTOCOL,
        apiVersion: TEXT_EDITOR_API_VERSION,
        setup(api) {
          api.addResolver({
            resolver: {
              id: "filesystem",
              async tryResolve(source) {
                if (source !== file) return { kind: "not-handled" };
                return {
                  kind: "resolved",
                  resource: {
                    source: file,
                    async read() {
                      return [{ type: "text", text: await readFile(file, "utf8") }];
                    },
                    async write(content) {
                      const block = content[0];
                      if (content.length !== 1 || block.type !== "text")
                        throw new Error("Expected text");
                      await writeFile(file, block.text);
                    },
                  },
                };
              },
            },
          });
        },
      });
      const { anchors: _anchors, pair: _pair, ...base } = replaceMutationTool;
      const definition = {
        ...base,
        async mutate() {
          return {
            edits: new Map([
              [
                file,
                {
                  changes: [{ from: 0, to: 6, insert: "after" }],
                  action: "edited" as const,
                },
              ],
            ]),
            async afterWrite() {
              throw Object.assign(new Error("Index publication failed"), {
                code: "GIT_INDEX_FAILED",
                effect,
              });
            },
          };
        },
      };
      core.addMutationTool(definition);
      const tool = createTextTool(
        core,
        definition,
        new ToolCallInterceptionRenderStore(),
        () => undefined,
      );
      const result = await tool.execute(
        "post-write-effect",
        { path: file, text: "after" },
        undefined,
        undefined,
        {
          cwd,
        } as ExtensionToolContext,
      );
      expect(await readFile(file, "utf8"), JSON.stringify(result)).toBe("after");
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({
        effect: effect === "unknown" ? "unknown" : "applied",
      });
      const output = result.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      expect(output).toContain("Completed writes:");
      await writeFile(file, "before");
      const journal = new BatchExecutionJournal(["post-write-batch"]);
      await executeRegisteredTextBatch(
        core,
        new Map([["replace", definition]]),
        { edits: [{ callId: "post-write-batch", op: "replace", path: file, text: "after" }] },
        undefined,
        undefined,
        { cwd } as ExtensionToolContext,
        journal.reporter(),
        () => undefined,
      );
      expect(await readFile(file, "utf8")).toBe("after");
      expect(journal.get("post-write-batch").failure?.effect).toBe(
        effect === "unknown" ? "unknown" : "applied",
      );
      expect(output).not.toContain("No file was changed.");
    } finally {
      await core.disposeApplyUndo();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
