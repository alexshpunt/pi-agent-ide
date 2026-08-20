import type { AgentContent, ResourceResolver } from "pi-agent-resource";
import type { TextLinePresenter } from "pi-agent-text";
import { expect, test } from "vitest";

import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_POSITION_ANCHOR_KIND,
  type TextEditorPlugin,
} from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";

test("runs registered edit handlers around the core operation", async () => {
  const core = createTextEditorCore();
  const order: string[] = [];
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "pipeline-observer",
    setup(api) {
      const tool = api.tool("fixture-editor");

      tool.addHandler({
        stage: "text-pre-edit",
        async handler(state) {
          order.push("pre-edit");
          await Promise.resolve();
          return {
            ...state,
            input: `${state.input as string}:pre`,
          };
        },
      });
      tool.addHandler({
        stage: "text-edit",
        handler(state) {
          order.push("edit");
          return {
            ...state,
            result: `${state.result as string}:edit`,
          };
        },
      });
      tool.addHandler({
        stage: "text-post-edit",
        handler(state) {
          order.push("post-edit");
          return {
            ...state,
            result: `${state.result as string}:post`,
          };
        },
      });
    },
  } satisfies TextEditorPlugin;

  await core.registerPlugin(plugin);
  const outcome = await core.executeEdit(
    "fixture-editor",
    { cwd: "/workspace", input: "input" },
    (state) => {
      order.push("operation");
      return `${state.input}:operation`;
    },
  );

  expect(order).toEqual(["pre-edit", "operation", "edit", "post-edit"]);
  expect(outcome).toEqual({
    kind: "completed",
    state: {
      cwd: "/workspace",
      input: "input:pre",
      result: "input:pre:operation:edit:post",
    },
  });
});

test("returns plugin and stage context when an edit handler fails", async () => {
  const core = createTextEditorCore();
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "failing-plugin",
    setup(api) {
      api.tool("fixture-editor").addHandler({
        stage: "text-edit",
        handler() {
          throw new Error("broken handler");
        },
      });
    },
  } satisfies TextEditorPlugin;

  await core.registerPlugin(plugin);
  const outcome = await core.executeEdit(
    "fixture-editor",
    { cwd: "/workspace", input: { path: "notes.md" } },
    () => ({ changed: true }),
  );

  expect(outcome).toMatchObject({
    kind: "failed",
    failure: {
      code: "PLUGIN_FAILED",
      pluginId: "failing-plugin",
      stage: "text-edit",
      tool: "fixture-editor",
      message: "Plugin failing-plugin failed during text-edit",
    },
  });
});

test("reads and writes through the same resource", async () => {
  const core = createTextEditorCore();
  const writes: AgentContent[] = [];
  const resolver = textResolver("filesystem", "notes.md", "before\n", writes);
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "filesystem-source",
    setup(api) {
      api.addResolver({ resolver });
    },
  } satisfies TextEditorPlugin;

  await core.registerPlugin(plugin);
  const outcome = await core.editText("notes.md", { cwd: "/workspace" }, (text) => ({
    text: text.replace("before", "after"),
    result: { changed: true },
  }));

  expect(outcome).toMatchObject({
    kind: "completed",
    source: "notes.md",
    resolvedBy: "filesystem",
    before: { source: "notes.md", content: "before\n" },
    after: { source: "notes.md", content: "after\n" },
    result: { changed: true },
  });
  expect(writes).toEqual([[{ type: "text", text: "after\n" }]]);
});

test("presents the after-document in stable priority order", async () => {
  const core = createTextEditorCore();
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "presenters",
    setup(api) {
      api.addResolver({ resolver: textResolver("filesystem", "notes.md", "before") });
      api.addTextPresenter({
        priority: 10,
        presenter: presenter("later", "B"),
      });
      api.addTextPresenter({
        priority: -1,
        presenter: presenter("first", "A"),
      });
    },
  });

  const outcome = await core.editText("notes.md", { cwd: "/workspace" }, () => ({
    text: "after",
    result: undefined,
  }));

  expect(outcome).toMatchObject({
    kind: "completed",
    before: { content: "before" },
    after: {
      content: "after",
      lines: [{ content: "after", presentation: { prefix: "AB" } }],
    },
  });
});

test("does not fall back after a resource lacks an editor capability", async () => {
  const core = createTextEditorCore();
  let fallbackCalls = 0;
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "capability-test",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "read-only",
          async tryResolve() {
            return {
              kind: "resolved",
              resource: {
                source: "notes.md",
                async read() {
                  return [{ type: "text", text: "before" }];
                },
              },
            };
          },
        },
      });
      api.addResolver({
        priority: 1,
        resolver: {
          id: "fallback",
          async tryResolve() {
            fallbackCalls += 1;
            return { kind: "not-handled" };
          },
        },
      });
    },
  } satisfies TextEditorPlugin;

  await core.registerPlugin(plugin);
  const outcome = await core.editText("notes.md", { cwd: "/workspace" }, (text) => ({
    text,
    result: undefined,
  }));

  expect(outcome).toMatchObject({
    kind: "failed",
    failure: { code: "UNSUPPORTED_CAPABILITY", resolverId: "read-only" },
  });
  expect(fallbackCalls).toBe(0);
});

test("does not fall back after malformed resolver output", async () => {
  const core = createTextEditorCore();
  let fallbackCalls = 0;
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "malformed-result-test",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "malformed",
          async tryResolve() {
            return undefined as never;
          },
        },
      });
      api.addResolver({
        priority: 1,
        resolver: {
          id: "fallback",
          async tryResolve() {
            fallbackCalls += 1;
            return { kind: "not-handled" };
          },
        },
      });
    },
  } satisfies TextEditorPlugin;

  await core.registerPlugin(plugin);
  const outcome = await core.editText("notes.md", { cwd: "/workspace" }, (text) => ({
    text,
    result: undefined,
  }));

  expect(outcome).toMatchObject({
    kind: "failed",
    failure: { code: "INVALID_RESOLVER_RESULT", resolverId: "malformed" },
  });
  expect(fallbackCalls).toBe(0);
});

test("validates resource read content and final write content", async () => {
  const invalidReadCore = createTextEditorCore();
  const invalidReadPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "invalid-read",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "invalid-read",
          async tryResolve() {
            return {
              kind: "resolved",
              resource: {
                source: "notes.md",
                async read() {
                  return [] as never;
                },
                async write() {},
              },
            };
          },
        },
      });
    },
  } satisfies TextEditorPlugin;

  await invalidReadCore.registerPlugin(invalidReadPlugin);
  await expect(
    invalidReadCore.editText("notes.md", { cwd: "/workspace" }, (text) => ({
      text,
      result: undefined,
    })),
  ).resolves.toMatchObject({
    kind: "failed",
    failure: { code: "INVALID_RESOURCE_CONTENT" },
  });

  const invalidWriteCore = createTextEditorCore();
  const writes: AgentContent[] = [];
  const invalidWritePlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "invalid-write",
    setup(api) {
      api.addResolver({ resolver: textResolver("invalid-write", "notes.md", "before", writes) });
    },
  } satisfies TextEditorPlugin;

  await invalidWriteCore.registerPlugin(invalidWritePlugin);
  await expect(
    invalidWriteCore.editText("notes.md", { cwd: "/workspace" }, () => ({
      text: 42 as never,
      result: undefined,
    })),
  ).resolves.toMatchObject({
    kind: "failed",
    failure: { code: "INVALID_WRITE_CONTENT" },
  });
  expect(writes).toEqual([]);
});

test("rejects duplicate resolvers without installing the failed setup draft", async () => {
  const core = createTextEditorCore();
  const firstPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "first-source",
    setup(api) {
      api.addResolver({ resolver: textResolver("filesystem", "notes.md", "before") });
    },
  } satisfies TextEditorPlugin;
  const conflictingPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "conflicting-source",
    setup(api) {
      api.addResolver({ resolver: textResolver("memory", "buffer:notes", "memory") });
      api.addResolver({ resolver: textResolver("filesystem", "notes.md", "conflict") });
    },
  } satisfies TextEditorPlugin;

  await core.registerPlugin(firstPlugin);
  await expect(core.registerPlugin(conflictingPlugin)).rejects.toThrow(/filesystem.*registered/u);
  await expect(
    core.editText("buffer:notes", { cwd: "/workspace" }, (text) => ({ text, result: undefined })),
  ).resolves.toMatchObject({ kind: "failed", failure: { code: "NO_RESOLVER" } });
  await expect(
    core.editText("notes.md", { cwd: "/workspace" }, (text) => ({
      text: `${text}!`,
      result: undefined,
    })),
  ).resolves.toMatchObject({ kind: "completed", after: { content: "before!" } });
});

test("rejects a malformed resolver during plugin registration", async () => {
  const core = createTextEditorCore();
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "malformed-resolver",
    setup(api) {
      api.addResolver({ resolver: { id: "broken" } } as never);
    },
  } satisfies TextEditorPlugin;

  await expect(core.registerPlugin(plugin)).rejects.toThrow(/invalid resource resolver/u);
});

test("renders lazy writable resources separately from tool descriptions", async () => {
  const core = createTextEditorCore();
  let current: string | undefined = "Writes fixture sources.\n- `text` — UTF-8 text.";
  let calls = 0;
  const provider = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "filesystem",
    setup(api) {
      api.describe(() => {
        calls += 1;
        return current;
      });
    },
  } satisfies TextEditorPlugin;
  const toolPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "write-pipeline",
    setup(api) {
      api.tool("write").describe("Adds fixture write behavior.");
    },
  } satisfies TextEditorPlugin;

  await core.registerPlugin(provider);
  await core.registerPlugin(toolPlugin);
  expect(core.renderGeneralPromptGuideline()).toBe(
    [
      "Text edits support these writable resources:",
      "  - `filesystem` — Writes fixture sources.",
      "    - `text` — UTF-8 text.",
    ].join("\n"),
  );
  expect(core.renderToolPromptGuideline("write")).toBe(
    [
      "write supports these installed extensions:",
      "  - `write-pipeline` — Adds fixture write behavior.",
    ].join("\n"),
  );
  expect(calls).toBe(1);

  expect(core.renderToolPromptGuideline("unknown")).toBeUndefined();
  expect(calls).toBe(1);

  current = undefined;
  expect(core.renderGeneralPromptGuideline()).toBeUndefined();
  expect(core.renderToolPromptGuideline("write")).toBe(
    [
      "write supports these installed extensions:",
      "  - `write-pipeline` — Adds fixture write behavior.",
    ].join("\n"),
  );
  expect(calls).toBe(2);
});

test("does not commit writable descriptions or tool IDs from failed setup", async () => {
  const core = createTextEditorCore();
  const failed = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "failed",
    setup(api) {
      api.describe("Writes leaked sources.");
      api.tool("write");
      throw new Error("setup failed");
    },
  } satisfies TextEditorPlugin;
  const provider = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "filesystem",
    setup(api) {
      api.describe("Writes fixture sources.");
    },
  } satisfies TextEditorPlugin;

  await expect(core.registerPlugin(failed)).rejects.toThrow("setup failed");
  await core.registerPlugin(provider);
  expect(core.renderGeneralPromptGuideline()).toBe(
    "Text edits support these writable resources:\n  - `filesystem` — Writes fixture sources.",
  );
  expect(core.renderToolPromptGuideline("write")).toBeUndefined();
});

test("fails writable prompt construction for invalid or throwing lazy descriptions", async () => {
  const invalidCore = createTextEditorCore();
  await invalidCore.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "invalid",
    setup(api) {
      api.tool("write");
      api.describe(() => 42 as never);
    },
  });
  expect(() => invalidCore.renderGeneralPromptGuideline()).toThrow(/description/u);

  const throwingCore = createTextEditorCore();
  const failure = new Error("broken description");
  await throwingCore.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "throwing",
    setup(api) {
      api.tool("write");
      api.describe(() => {
        throw failure;
      });
    },
  });
  expect(() => throwingCore.renderGeneralPromptGuideline()).toThrow(failure);
});

test("adds compact anchor guidance to the editor prompt", async () => {
  const core = createTextEditorCore();
  core.registerTool("replace");
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "anchor-plugin",
    setup(api) {
      api.addAnchorResolver({
        kind: TEXT_POSITION_ANCHOR_KIND,
        type: "major",
        resolver: {
          id: "fixture-anchor",
          description: "Use `LINE#FIXTURE`.",
          tryResolve: () => Promise.resolve({ kind: "not-handled" }),
        },
      });
    },
  });

  expect(core.renderGeneralPromptGuideline()).toContain(
    [
      "Text editor anchors:",
      "  - Use `LINE#FIXTURE`.",
      "",
      "  Pass anchors exactly as shown.",
    ].join("\n"),
  );
});

function presenter(id: string, prefix: string): TextLinePresenter {
  return {
    id,
    present(document) {
      return {
        ...document,
        lines: document.lines.map((line) => ({
          ...line,
          presentation: {
            ...line.presentation,
            prefix: `${line.presentation?.prefix ?? ""}${prefix}`,
          },
        })),
      };
    },
  };
}
function textResolver(
  id: string,
  supportedSource: string,
  initialText: string,
  writes: AgentContent[] = [],
): ResourceResolver {
  let text = initialText;
  return {
    id,
    async tryResolve(source) {
      if (source !== supportedSource) {
        return { kind: "not-handled" };
      }

      return {
        kind: "resolved",
        resource: {
          source,
          async read() {
            return [{ type: "text", text }];
          },
          async write(content) {
            writes.push(content);
            const block = content[0];

            if (content.length === 1 && block.type === "text") {
              text = block.text;
            }
          },
        },
      };
    },
  };
}
