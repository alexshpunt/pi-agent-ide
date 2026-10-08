import type { AgentContent, ResourceResolver } from "pi-agent-resource";
import type { TextLinePresenter } from "pi-agent-text";
import { expect, test } from "vitest";

import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type TextEditorPlugin,
} from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";

test("a reloaded core restores retained receipts through their original journal owners", async () => {
  const first = createTextEditorCore();
  const source = "ssh://sandbox/tmp/reload.txt";
  let bytes = Buffer.from("before");
  let released = 0;
  const provider = Object.assign(
    (previous: ReturnType<typeof first.getApplyFileAccess>) => ({
      ...previous,
      ownerKey: () => "sandbox:host",
      capture: async () => ({ path: source, existed: true, bytes }),
      restore: async (state: { bytes?: Uint8Array }) => {
        bytes = Buffer.from(state.bytes ?? []);
      },
    }),
    {
      async dispose() {
        released += 1;
      },
    },
  );
  await first.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "retained-owner",
    setup(api) {
      api.addApplyFileAccessProvider(provider);
    },
  });
  const access = first.getApplyFileAccess({ cwd: "/tmp" });
  const before = await access.capture(source);
  bytes = Buffer.from("after");
  const receipt = await first.recordApplyUndo([before], access);
  const retained = await first.detachApplyUndo();
  expect(released).toBe(0);
  const next = createTextEditorCore();
  await next.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "current-owner",
    setup(api) {
      api.addApplyFileAccessProvider((previous) => ({
        ...previous,
        ownerKey: () => "sandbox:host",
      }));
    },
  });
  await next.adoptApplyUndo(retained);
  await expect(next.adoptApplyUndo(retained)).rejects.toThrow(
    "Apply core already owns session journals.",
  );
  expect(next.hasApplyUndo(receipt)).toBe(true);
  await next.restoreApplyUndo(receipt);
  expect(bytes.toString()).toBe("before");
  await first.disposeApplyUndo();
  expect(released).toBe(0);
  await next.disposeApplyUndo();
  expect(released).toBe(1);
});
test("Apply owners release journals only after queued mutations finish", async () => {
  const core = createTextEditorCore();
  const events: string[] = [];
  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const provider = Object.assign((access: ReturnType<typeof core.getApplyFileAccess>) => access, {
    async dispose() {
      events.push("owner disposed");
    },
  });
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "journal-lifetime",
    setup(api) {
      api.addApplyFileAccessProvider(provider);
    },
  });
  const operation = core.enqueueFileOperation(async () => {
    events.push("mutation started");
    await gate;
    events.push("mutation finished");
  });
  const shutdown = core.disposeApplyUndo();
  await Promise.resolve();
  expect(events).not.toContain("owner disposed");
  finish?.();
  await operation;
  await shutdown;
  expect(events).toEqual(["mutation started", "mutation finished", "owner disposed"]);
});
test("Apply owner registration is lazy and failed setup contributes nothing", async () => {
  const core = createTextEditorCore();
  let failedCalls = 0;
  await expect(
    core.registerPlugin({
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "failed-apply-owner",
      setup(api) {
        api.addApplyFileAccessProvider((access) => {
          failedCalls += 1;
          return access;
        });
        throw new Error("Setup failed");
      },
    }),
  ).rejects.toThrow("Setup failed");
  let calls = 0;
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "apply-owner",
    setup(api) {
      api.addApplyFileAccessProvider((access, context) => {
        calls += 1;
        expect(context.cwd).toBe("ssh://sandbox/tmp");
        return { ...access, capture: async (source) => ({ path: source, existed: false }) };
      });
    },
  });
  expect(calls).toBe(0);
  const access = core.getApplyFileAccess({ cwd: "ssh://sandbox/tmp" });
  expect(await access.capture("ssh://sandbox/tmp/owned")).toEqual({
    path: "ssh://sandbox/tmp/owned",
    existed: false,
  });
  expect(calls).toBe(1);
  expect(failedCalls).toBe(0);
});

test("registered whole-file owners receive SSH inputs through core dispatch", async () => {
  const core = createTextEditorCore();
  const calls: unknown[] = [];
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "file-owner",
    setup(api) {
      api.addFileOperationResolver(async (operation, input, context) => {
        calls.push({ operation, input, context });
        return {
          kind: "file-operation",
          operation,
          ok: true,
          effect: "applied",
          path: "ssh://sandbox/tmp/source",
          target: "ssh://sandbox/tmp/target",
        };
      });
    },
  });
  const input = { path: "source", target: "target" };
  expect(await core.executeFileOperation("copy", input, "ssh://sandbox/tmp")).toMatchObject({
    ok: true,
    effect: "applied",
    path: "ssh://sandbox/tmp/source",
  });
  expect(calls).toEqual([
    { operation: "copy", input, context: { cwd: "ssh://sandbox/tmp", signal: undefined } },
  ]);
});

test("failed plugin setup does not leak a whole-file owner", async () => {
  const core = createTextEditorCore();
  let called = false;
  await expect(
    core.registerPlugin({
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "failed-file-owner",
      setup(api) {
        api.addFileOperationResolver(async (operation, input) => {
          called = true;
          return {
            kind: "file-operation",
            operation,
            ok: true,
            effect: "applied",
            path: input.path,
          };
        });
        throw new Error("Setup failed");
      },
    }),
  ).rejects.toThrow("Setup failed");
  expect(
    await core.executeFileOperation("delete", { path: "ssh://sandbox/file" }, "/local"),
  ).toMatchObject({ ok: false, effect: "not-applied", error: { code: "UNSUPPORTED_SOURCE" } });
  expect(called).toBe(false);
});

test("whole-file post-processing uses the URI owner instead of a local path", async () => {
  const core = createTextEditorCore();
  const source = "ssh://sandbox/file.txt";
  const observed: unknown[] = [];
  let reads = 0;
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "post-edit-owner",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "post-edit-owner",
          async tryResolve(value) {
            if (value !== source) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  reads += 1;
                  return [{ type: "text", text: "remote text" }];
                },
              },
            };
          },
        },
      });
    },
  });
  core.registerPostEditHandler({
    id: "observe-owned-text",
    handler(transaction) {
      observed.push({
        source: transaction.source,
        resourceSource: transaction.resourceSource,
        text: transaction.requestedAfter.content,
      });
    },
  });
  await core.postProcessFile(source, { cwd: "/local" });
  expect(reads).toBeGreaterThan(0);
  expect(observed).toEqual([{ source, resourceSource: source, text: "remote text" }]);
});

test("whole-file binary post-processing skips text conversion and handlers", async () => {
  const core = createTextEditorCore();
  const source = "ssh://sandbox/file.bin";
  let byteReads = 0;
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "binary-post-edit-owner",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "binary-post-edit-owner",
          async tryResolve(value) {
            if (value !== source) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  throw new Error("Binary contents must not enter text conversion");
                },
                async readBytes() {
                  byteReads += 1;
                  return { bytes: new Uint8Array([0, 255]), byteOffset: 0, totalBytes: 2 };
                },
              },
            };
          },
        },
      });
    },
  });
  core.registerPostEditHandler({
    id: "reject-binary-text",
    handler() {
      throw new Error("Binary file must not be post-processed");
    },
  });
  await core.postProcessFile(source, { cwd: "/local" });
  expect(byteReads).toBe(1);
});

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
    },
  });
});

test("rolls back earlier resources when a later write fails", async () => {
  const core = createTextEditorCore();
  const values = new Map([
    ["first.txt", "first before"],
    ["second.txt", "second before"],
  ]);
  const writes = new Map<string, string[]>();
  const writeAttempts = new Map<string, number>();
  const controller = new AbortController();
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "atomic-fixture",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "atomic-files",
          async tryResolve(source) {
            if (!values.has(source)) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  return [{ type: "text", text: values.get(source) ?? "" }];
                },
                async write(content) {
                  const text = content[0].type === "text" ? content[0].text : "";
                  writes.set(source, [...(writes.get(source) ?? []), text]);
                  const attempt = (writeAttempts.get(source) ?? 0) + 1;
                  writeAttempts.set(source, attempt);
                  if (source === "second.txt" && attempt >= 2) {
                    throw new Error("injected rollback failure");
                  }
                  values.set(source, text);
                  if (source === "second.txt") {
                    controller.abort();
                    throw new Error("injected write failure after mutation");
                  }
                },
              },
            };
          },
        },
      });
    },
  } satisfies TextEditorPlugin;
  await core.registerPlugin(plugin);

  const outcome = await core.editTexts(
    [
      { source: "first.txt", read: true },
      { source: "second.txt", read: true },
    ],
    { cwd: "/workspace", signal: controller.signal },
    async (texts) => ({
      changes: new Map(
        [...texts].map(([source, text]) => [
          source,
          [{ from: 0, to: text.length, insert: `${text} changed` }],
        ]),
      ),
      result: undefined,
    }),
  );

  expect(outcome).toMatchObject({ kind: "failed", completed: ["second.txt"] });
  expect(values.get("first.txt")).toBe("first before");
  expect(values.get("second.txt")).toBe("second before changed");
  expect(writes.get("first.txt")).toEqual(["first before changed", "first before"]);
});

test("does not compensate a resource whose write was explicitly not applied", async () => {
  const core = createTextEditorCore();
  const values = new Map([
    ["first.txt", "before"],
    ["conflict.txt", "before"],
  ]);
  const writes: string[] = [];
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "guarded-write-fixture",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "guarded-files",
          async tryResolve(source) {
            if (!values.has(source)) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  return [{ type: "text", text: values.get(source) ?? "" }];
                },
                async write(content) {
                  writes.push(source);
                  if (source === "conflict.txt") {
                    values.set(source, "external");
                    throw Object.assign(new Error("snapshot conflict"), { effect: "not-applied" });
                  }
                  values.set(source, content[0].type === "text" ? content[0].text : "");
                },
              },
            };
          },
        },
      });
    },
  });
  const outcome = await core.editTexts(
    [...values.keys()].map((source) => ({ source, read: true })),
    { cwd: "/workspace" },
    async (texts) => ({
      changes: new Map(
        [...texts].map(([source, text]) => [
          source,
          [{ from: 0, to: text.length, insert: "after" }],
        ]),
      ),
      result: undefined,
    }),
  );
  expect(outcome).toMatchObject({
    kind: "failed",
    completed: [],
    failure: { code: "WRITE_FAILED" },
  });
  expect(writes).toEqual(["first.txt", "conflict.txt", "first.txt"]);
  expect(values.get("first.txt")).toBe("before");
  expect(values.get("conflict.txt")).toBe("external");
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
  core.renderGeneralPromptGuideline();
  core.renderToolPromptGuideline("write");
  expect(calls).toBe(1);

  expect(core.renderToolPromptGuideline("unknown")).toBeUndefined();
  expect(calls).toBe(1);

  current = undefined;
  expect(core.renderGeneralPromptGuideline()).toBeUndefined();
  core.renderToolPromptGuideline("write");
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

test("single and multi-resource edits share the whole read-modify-write queue", async () => {
  const core = createTextEditorCore();
  await core.registerPlugin({
    id: "queued-source",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addResolver({ resolver: textResolver("memory", "note.txt", "") });
    },
  });
  const first = core.editText("note.txt", { cwd: "/workspace" }, async (text) => {
    await Promise.resolve();
    return { text: `${text}A`, result: null };
  });
  const second = core.editTexts(
    [{ source: "note.txt", read: true }],
    { cwd: "/workspace" },
    (texts) => {
      const content = texts.get("note.txt") ?? "";
      return {
        changes: new Map([
          ["note.txt", [{ from: content.length, to: content.length, insert: "B" }]],
        ]),
        result: null,
      };
    },
  );
  await Promise.all([first, second]);
  const final = await core.editText("note.txt", { cwd: "/workspace" }, (text) => ({
    text,
    result: null,
  }));
  expect(final).toMatchObject({ kind: "completed", after: { content: "AB" } });
});
