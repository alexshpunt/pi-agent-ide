import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { TEXT_EDITOR_PROTOCOL, TEXT_EDITOR_API_VERSION } from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import {
  executeScriptMutation,
  executeTextMutation,
  previewTextMutation,
} from "#src/core/text-mutation.js";
import { writeMutationTool } from "#src/tools/tool-text-write.js";
import { replaceMutationTool } from "#src/tools/tool-text-replace.js";
import { TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import { insertMutationTool } from "#src/tools/tool-text-insert.js";
import { createExactTextAnchorResolver } from "pi-agent-text-anchor-exact/api/anchor";

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

test("semantic insert resolves an anchor without writing source text", async () => {
  const core = createTextEditorCore();
  const source = "first line\nbreak here\nlast line\n";
  core.addMutationTool(insertMutationTool);
  let writes = 0;
  let completions = 0;
  let semanticEffects = 0;
  await core.registerPlugin({
    id: "semantic-insert",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addResolver({
        resolver: {
          id: "debug-source",
          tryResolve: async (requested) => ({
            kind: "resolved",
            resource: {
              source: requested,
              read: async () => [{ type: "text", text: source }],
            },
          }),
        },
      });
      api.addAnchorResolver({
        kind: TEXT_SEARCH_ANCHOR_KIND,
        type: "major",
        resolver: createExactTextAnchorResolver({
          fuzzyEnabled: false,
          threshold: 0.8,
          exactCandidateLimit: 20,
          fuzzyCandidateLimit: 5,
          maxFileSizeMiB: 20,
          maxQuerySizeKiB: 1024,
          seedLimit: 3,
          blockLineVariance: 2,
          contextLines: 5,
          timeoutMs: 2000,
        }),
      });
      api.tool("insert").addSemanticHandler({
        matches(input) {
          return (
            typeof input === "object" &&
            input !== null &&
            (input as { path?: unknown }).path === "debug:session/source/example.py"
          );
        },
        async execute(context, input) {
          semanticEffects++;
          const parameters = input as { anchor?: string; text?: string };
          if (parameters.text !== "breakpoint" || parameters.anchor === undefined) {
            throw new Error("Expected one breakpoint command and anchor");
          }
          const anchor = await context.resolveAnchor("anchor");
          return {
            source: "debug:session/breakpoint/1",
            summary: "Breakpoint created at example.py:2",
            data: {
              kind: "debug-breakpoint",
              line: anchor.lineNumber,
            },
          };
        },
      });
      api.onDidEdit(() => {
        completions++;
      });
    },
  });

  const result = await executeScriptMutation(
    core,
    insertMutationTool,
    {
      path: "debug:session/source/example.py",
      anchor: "break here",
      text: "breakpoint",
    },
    undefined,
    { cwd: process.cwd() } as ExtensionContext,
  );

  expect(result).toMatchObject({
    operation: "insert",
    ok: true,
    effect: "applied",
    files: [],
    completed: ["debug:session/breakpoint/1"],
    metadata: {
      semanticAction: { kind: "debug-breakpoint", line: 2 },
    },
    errors: [],
  });
  const standalone = await executeTextMutation(
    core,
    insertMutationTool,
    {
      path: "debug:session/source/example.py",
      anchor: "break here",
      text: "breakpoint",
    },
    undefined,
    { cwd: process.cwd() } as ExtensionContext,
  );
  expect(standalone.content).toEqual([
    { type: "text", text: "Breakpoint created at example.py:2" },
  ]);
  expect(standalone.details).toMatchObject({
    results: [],
    metadata: {
      semanticAction: {
        kind: "debug-breakpoint",
        line: 2,
        source: "debug:session/breakpoint/1",
      },
    },
  });
  const preview = await previewTextMutation(core, {
    tool: "insert",
    input: {
      path: "debug:session/source/example.py",
      anchor: "break here",
      text: "breakpoint",
    },
    cwd: process.cwd(),
  });
  expect(preview).toMatchObject({
    kind: "completed",
    resources: [{ beforeContent: source, afterContent: source, ranges: [] }],
  });
  expect(semanticEffects).toBe(2);

  const stale = await executeTextMutation(
    core,
    insertMutationTool,
    {
      path: "debug:session/source/example.py",
      anchor: "no longer present",
      text: "breakpoint",
    },
    undefined,
    { cwd: process.cwd() } as ExtensionContext,
  );
  expect(stale.details.results?.[0]?.data.ok).toBe(false);
  expect(semanticEffects).toBe(2);
  expect(writes).toBe(0);
  expect(completions).toBe(0);
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
