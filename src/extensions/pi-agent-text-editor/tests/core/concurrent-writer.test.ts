import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ResourceError } from "pi-agent-resource";
import { resolveExactTextAnchor } from "pi-agent-text-anchor-exact/api/anchor";
import { expect, test } from "vitest";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_SEARCH_ANCHOR_KIND,
} from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { executeTextMutation } from "#src/core/text-mutation.js";
import { replaceMutationTool } from "#src/tools/tool-text-replace.js";

const source = "fixture://shared.txt";

/**
 * A file that another process appends to between this process's read and write, `changes`
 * times. Like the filesystem resolver, a write refuses to replace text it has not read.
 */
async function sharedFile(changes: number) {
  const file = { text: "alpha beta\n", writes: 0 };
  let pending = changes;
  const core = createTextEditorCore();
  await core.registerPlugin({
    id: "fixture",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addAnchorResolver({
        kind: TEXT_SEARCH_ANCHOR_KIND,
        type: "auxiliary",
        resolver: {
          id: "exact",
          description: "Exact text",
          renderFull: (value) => value,
          renderCompact: (value) => value,
          tryResolve: (value, document) => Promise.resolve(resolveExactTextAnchor(value, document)),
        },
      });
      api.addResolver({
        resolver: {
          id: "fixture",
          async tryResolve(requested) {
            if (requested !== source) return { kind: "not-handled" };
            let readText: string | undefined;
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  readText = file.text;
                  return [{ type: "text", text: file.text }];
                },
                async write(content) {
                  if (pending > 0) {
                    pending -= 1;
                    file.text += `other ${String(changes - pending)}\n`;
                  }
                  if (readText !== file.text)
                    throw new ResourceError("RESOURCE_CHANGED", source, "not-applied");
                  file.writes += 1;
                  file.text = content[0].type === "text" ? content[0].text : "";
                  readText = file.text;
                },
              },
            };
          },
        },
      });
    },
  });
  const result = await executeTextMutation(
    core,
    replaceMutationTool,
    { path: source, start: "beta", text: "gamma" },
    undefined,
    { cwd: process.cwd() } as ExtensionContext,
  );
  return { file, result };
}

test("an edit whose file another process changed is applied again to the current text", async () => {
  const { file, result } = await sharedFile(2);

  expect(file.text).toBe("alpha gamma\nother 1\nother 2\n");
  expect(file.writes).toBe(1);
  expect(result.details.results?.[0]?.data.ok).toBe(true);
});

test("an edit stops without writing when its file keeps changing", async () => {
  const { file, result } = await sharedFile(100);

  expect(file.writes).toBe(0);
  expect(file.text).toContain("alpha beta\n");
  expect(result.details.results?.[0]?.data.ok).toBe(false);
  expect(result.details.effect).toBe("not-applied");
});
