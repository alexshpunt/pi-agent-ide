import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { Value } from "typebox/value";
import { ResultTargetStore } from "pi-agent-resource";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { createResultTargetAnchors } from "#src/core/result-target-anchors.js";
import { createTextTool } from "#src/core/text-mutation.js";
import { ToolCallInterceptionRenderStore } from "#src/core/tool-call-interceptor/rendering.js";
import { writeMutationTool } from "#src/tools/tool-text-write.js";
import { deleteMutationTool } from "#src/tools/tool-text-delete.js";

for (const operation of ["write", "delete"] as const) {
  test(`${operation} respects whole-file versus selected-text result authority`, async () => {
    const base = path.resolve(".tmp/result-file-tests");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "workspace-"));
    const file = path.join(cwd, "note.txt");
    const content = "before café after\r\n";
    try {
      await writeFile(file, content);
      const store = new ResultTargetStore();
      const core = createTextEditorCore();
      const definition = operation === "write" ? writeMutationTool : deleteMutationTool;
      core.addMutationTool(definition);
      await core.registerPlugin({
        id: "result-file-test",
        protocol: TEXT_EDITOR_PROTOCOL,
        apiVersion: TEXT_EDITOR_API_VERSION,
        setup(api) {
          api.addAnchorResolver(createResultTargetAnchors(store));
          api.addResolver({
            resolver: {
              id: "owned-file",
              async tryResolve(source) {
                if (source !== file) return { kind: "not-handled" };
                return {
                  kind: "resolved",
                  resource: {
                    source,
                    async read() {
                      return [{ type: "text", text: await readFile(file, "utf8") }];
                    },
                    async write(blocks) {
                      const block = blocks[0];
                      if (blocks.length !== 1 || block.type !== "text")
                        throw Error("Expected owned text");
                      await writeFile(file, block.text);
                    },
                  },
                };
              },
            },
          });
        },
      });
      const execute = async (id: string, target: string, whole: boolean) => {
        const context = { cwd } as ExtensionToolContext;
        if (operation === "write") {
          const tool = createTextTool(
            core,
            writeMutationTool,
            new ToolCallInterceptionRenderStore(),
            () => undefined,
            store,
          );
          return tool.execute(
            id,
            { path: { target }, content: whole ? "saved café\n" : "must not widen" },
            undefined,
            undefined,
            context,
          );
        }
        const tool = createTextTool(
          core,
          deleteMutationTool,
          new ToolCallInterceptionRenderStore(),
          () => undefined,
          store,
        );
        return tool.execute(id, { path: { target } }, undefined, undefined, context);
      };
      const reference = (whole: boolean) =>
        store.register(
          [
            {
              source: file,
              expectedContent: content,
              ranges: whole
                ? [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 2, column: 0 } }]
                : [{ start: { lineNumber: 1, column: 7 }, end: { lineNumber: 1, column: 11 } }],
            },
          ],
          cwd,
        );
      const partial = {
        path: { target: reference(false) },
        ...(operation === "write" ? { content: "must not widen" } : {}),
      };
      expect(Value.Check(definition.parameters, partial)).toBe(true);
      const partialResult = await execute("partial", partial.path.target, false);
      if (operation === "write") {
        expect(partialResult.details.effect).toBe("not-applied");
        expect(await readFile(file, "utf8")).toBe(content);
      } else {
        expect(partialResult.details.effect).not.toBe("not-applied");
        expect(await readFile(file, "utf8")).toBe("before  after\r\n");
        await writeFile(file, content);
      }
      const whole = {
        path: { target: reference(true) },
        ...(operation === "write" ? { content: "saved café\n" } : {}),
      };
      expect(Value.Check(definition.parameters, whole)).toBe(true);
      const wholeResult = await execute("whole", whole.path.target, true);
      expect(wholeResult.details.effect).not.toBe("not-applied");
      expect(await readFile(file, "utf8")).toBe(operation === "write" ? "saved café\n" : "");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
