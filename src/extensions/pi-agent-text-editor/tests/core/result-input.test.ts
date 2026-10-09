import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { createResultTargetAnchors } from "#src/core/result-target-anchors.js";
import { createTextTool } from "#src/core/text-mutation.js";
import { ToolCallInterceptionRenderStore } from "#src/core/tool-call-interceptor/rendering.js";
import { replaceMutationTool } from "#src/tools/tool-text-replace.js";

for (const complete of [true, false]) {
  test(`structured replace keeps registered bounds and ${complete ? "uses" : "refuses"} complete authority`, async () => {
    const base = path.resolve(".tmp/result-input-tests");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "workspace-"));
    const file = path.join(cwd, "note.txt");
    const content = "before café after\r\n";
    try {
      await writeFile(file, content);
      const store = new ResultTargetStore();
      const target = store.register(
        [
          {
            source: file,
            expectedContent: content,
            ranges: [{ start: { lineNumber: 1, column: 7 }, end: { lineNumber: 1, column: 11 } }],
          },
        ],
        cwd,
        complete,
      );
      const core = createTextEditorCore();
      core.addMutationTool(replaceMutationTool);
      await core.registerPlugin({
        id: "result-test",
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
      const tool = createTextTool(
        core,
        replaceMutationTool,
        new ToolCallInterceptionRenderStore(),
        () => undefined,
        store,
      );
      const result = await tool.execute(
        "structured-replace",
        {
          path: target,
          text: "READY",
        },
        undefined,
        undefined,
        { cwd } as ExtensionToolContext,
      );
      if (complete) {
        expect(await readFile(file, "utf8")).toBe("before READY after\r\n");
        expect(result.details.effect).not.toBe("not-applied");
      } else {
        expect(result.details.effect).toBe("not-applied");
        expect(
          result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
        ).toContain("Incomplete result targets");
        expect(await readFile(file, "utf8")).toBe(content);
      }
      const empty = await tool.execute(
        "empty",
        { path: [], text: "must not write" },
        undefined,
        undefined,
        { cwd } as ExtensionToolContext,
      );
      expect(empty.details.effect).toBe("not-applied");
      expect(await readFile(file, "utf8")).toBe(complete ? "before READY after\r\n" : content);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
