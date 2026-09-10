import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { TEXT_EDITOR_PROTOCOL, TEXT_EDITOR_API_VERSION } from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { executeScriptMutation } from "#src/core/text-mutation.js";
import { writeMutationTool } from "#src/tools/tool-text-write.js";
import { replaceMutationTool } from "#src/tools/tool-text-replace.js";
import { TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";

test("script mutations use post-edit processing and return plain final content", async () => {
  const core = createTextEditorCore();
  let text = "before\n";
  await core.registerPlugin({
    id: "resource",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addResolver({
        resolver: {
          id: "fixture",
          async tryResolve(source) {
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  return [{ type: "text", text }];
                },
                async write(content) {
                  const block = content[0];
                  if (block.type !== "text") throw new Error("Expected text");
                  text = block.text;
                },
              },
            };
          },
        },
      });
    },
  });
  core.registerPostEditHandler({
    id: "format",
    async handler() {
      text = text.toUpperCase();
      return { formatting: { status: "changed", formatter: "fixture" } };
    },
  });
  const result = await executeScriptMutation(
    core,
    writeMutationTool,
    { path: "fixture.txt", content: "after\n" },
    undefined,
    { cwd: process.cwd() } as ExtensionContext,
  );
  expect(result).toMatchObject({
    ok: true,
    effect: "applied",
    files: [{ source: "fixture.txt", before: "before\n", after: "AFTER\n" }],
  });
  expect(text).toBe("AFTER\n");
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  expect(result.files[0]?.formatting.status).toBe("changed");
  await core.registerPlugin({
    id: "late-failure",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.tool("write").addHandler({
        stage: "text-post-edit",
        handler() {
          throw new Error("late failure");
        },
      });
    },
  });
  const failed = await executeScriptMutation(
    core,
    writeMutationTool,
    { path: "fixture.txt", content: "third\n" },
    undefined,
    { cwd: process.cwd() } as ExtensionContext,
  );
  expect(failed).toMatchObject({
    ok: false,
    effect: "applied",
    files: [{ source: "fixture.txt", before: "AFTER\n", after: "THIRD\n" }],
  });
  expect(text).toBe("THIRD\n");
});

test("script mutation arguments are validated before any resolver runs", async () => {
  const core = createTextEditorCore();
  await expect(
    executeScriptMutation(
      core,
      writeMutationTool,
      { path: "fixture.txt", content: 42 },
      undefined,
      { cwd: process.cwd() } as ExtensionContext,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
});

test("resolved declaration snapshots reject changed source text before writing", async () => {
  const core = createTextEditorCore();
  let writes = 0;
  await core.registerPlugin({
    id: "selection",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addResolver({
        resolver: {
          id: "memory",
          tryResolve: async (source) => ({
            kind: "resolved",
            resource: {
              source,
              read: async () => [{ type: "text", text: "changed" }],
              write: async () => {
                writes++;
              },
            },
          }),
        },
      });
      api.addAnchorResolver({
        kind: TEXT_SEARCH_ANCHOR_KIND,
        type: "auxiliary",
        resolver: {
          id: "selection",
          description: "fixture",
          renderFull: (value) => value,
          renderCompact: (value) => value,
          tryResolve: async () => ({ kind: "not-handled" }),
        },
        resources: {
          id: "selection",
          tryResolve: async () => ({
            kind: "resolved",
            targets: [
              {
                source: "source.txt",
                expectedContent: "original",
                ranges: [
                  { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 8 } },
                ],
              },
            ],
          }),
        },
      });
    },
  });
  const outcome = await executeScriptMutation(
    core,
    replaceMutationTool,
    { path: "symbol:source.txt#Name", text: "replacement" },
    undefined,
    { cwd: process.cwd() } as ExtensionContext,
  );
  expect(outcome.ok).toBe(false);
  expect(outcome.effect).toBe("not-applied");
  expect(writes).toBe(0);
});

test("native edit plans validate every file snapshot before any writes", async () => {
  const core = createTextEditorCore();
  let writes = 0;
  await core.registerPlugin({
    id: "native-plan",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addResolver({
        resolver: {
          id: "memory",
          tryResolve: async (source) => ({
            kind: "resolved",
            resource: {
              source,
              read: async () => [{ type: "text", text: source === "first.ts" ? "old" : "changed" }],
              write: async () => {
                writes++;
              },
            },
          }),
        },
      });
      api.tool("replace").addHandler({
        stage: "text-pre-edit",
        handler: (state) => ({
          ...state,
          editPlan: {
            files: ["first.ts", "second.ts"].map((source) => ({
              source,
              expectedContent: "old",
              changes: [{ from: 0, to: 3, insert: "new" }],
            })),
          },
        }),
      });
    },
  });
  const result = await executeScriptMutation(
    core,
    replaceMutationTool,
    { path: "symbol:first.ts#old#name", text: "new" },
    undefined,
    { cwd: process.cwd() } as ExtensionContext,
  );
  expect(result.ok).toBe(false);
  expect(result.effect).toBe("not-applied");
  expect(writes).toBe(0);
});
