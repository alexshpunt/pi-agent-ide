import type { AgentContent, ResourceResolver } from "pi-agent-resource";
import { expect, test } from "vitest";

import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type TextEditorPlugin,
} from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { createPostEditScope } from "#src/core/post-edit-scope.js";

test("waits for post-edit work after writing and rereads the final text", async () => {
  const core = createTextEditorCore();
  let text = "before\n";
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });

  await core.registerPlugin(
    resourcePlugin(
      mutableResolver(
        () => text,
        (next) => {
          text = next;
        },
      ),
    ),
  );
  core.registerPostEditHandler({
    id: "fixture-post-edit",
    async handler(transaction) {
      expect(text).toBe("requested\n");
      expect(transaction).toMatchObject({
        source: "notes.md",
        resourceSource: "/workspace/notes.md",
        resolvedBy: "filesystem",
        cwd: "/workspace",
        before: { content: "before\n" },
        requestedAfter: { content: "requested\n" },
      });
      await waiting;
      text = "formatted\n";
      return { phase: "complete" };
    },
  });

  let completed = false;
  const editing = core
    .editText("notes.md", { cwd: "/workspace" }, () => ({
      text: "requested\n",
      result: { changed: true },
    }))
    .then((outcome) => {
      completed = true;
      return outcome;
    });

  await Promise.resolve();
  expect(completed).toBe(false);
  release?.();

  await expect(editing).resolves.toMatchObject({
    kind: "completed",
    after: { content: "formatted\n" },
    postEditContributions: [{ id: "fixture-post-edit", data: { phase: "complete" } }],
  });
});

test("keeps a saved resource separate from interrupted post-edit work", async () => {
  const core = createTextEditorCore();
  const cancellation = new AbortController();
  let text = "before\n";
  await core.registerPlugin(
    resourcePlugin(
      mutableResolver(
        () => text,
        (next) => {
          text = next;
        },
      ),
    ),
  );
  core.registerPostEditHandler({
    id: "cancel-after-save",
    handler() {
      expect(text).toBe("saved\n");
      cancellation.abort();
      cancellation.signal.throwIfAborted();
    },
  });
  const completions: unknown[] = [];
  core.onDidEdit((completion) => {
    completions.push(completion);
  });
  const result = await core.editText(
    "notes.md",
    { cwd: "/workspace", signal: cancellation.signal },
    () => ({
      text: "saved\n",
      result: undefined,
    }),
  );
  expect(result.kind).toBe("completed");
  expect(text).toBe("saved\n");
  expect(completions).toEqual([expect.objectContaining({ postProcessing: "interrupted" })]);
  if (result.kind === "completed")
    expect(result.postEditContributions).toContainEqual(
      expect.objectContaining({
        data: {
          diffStatuses: [
            expect.objectContaining({
              tone: "warning",
            }),
          ],
        },
      }),
    );
});
test("presents the content reread after post-edit work", async () => {
  const core = createTextEditorCore();
  let text = "before";

  await core.registerPlugin({
    ...resourcePlugin(
      mutableResolver(
        () => text,
        (next) => {
          text = next;
        },
      ),
    ),
    id: "resource-and-presenter",
    setup(api) {
      api.addResolver({
        resolver: mutableResolver(
          () => text,
          (next) => {
            text = next;
          },
        ),
      });
      api.addTextPresenter({
        presenter: {
          id: "final-content-presenter",
          present(document) {
            expect(document.content).toBe("fixed");
            return {
              ...document,
              lines: document.lines.map((line) => ({
                ...line,
                presentation: { prefix: "FINAL#" },
              })),
            };
          },
        },
      });
    },
  });
  core.registerPostEditHandler({
    id: "fixer",
    handler() {
      text = "fixed";
    },
  });

  await expect(
    core.editText("notes.md", { cwd: "/workspace" }, () => ({
      text: "requested",
      result: undefined,
    })),
  ).resolves.toMatchObject({
    kind: "completed",
    after: {
      content: "fixed",
      lines: [{ content: "fixed", presentation: { prefix: "FINAL#" } }],
    },
  });
});

test("does not run post-edit work when writing fails", async () => {
  const core = createTextEditorCore();
  let postEditCalls = 0;
  const resolver: ResourceResolver = {
    id: "filesystem",
    async tryResolve() {
      return {
        kind: "resolved",
        resource: {
          source: "/workspace/notes.md",
          async read() {
            return [{ type: "text", text: "before" }];
          },
          async write() {
            throw new Error("disk failure");
          },
        },
      };
    },
  };

  await core.registerPlugin(resourcePlugin(resolver));
  core.registerPostEditHandler({
    id: "observer",
    handler() {
      postEditCalls += 1;
    },
  });

  await expect(
    core.editText("notes.md", { cwd: "/workspace" }, () => ({ text: "after", result: undefined })),
  ).resolves.toMatchObject({ kind: "failed", failure: { code: "WRITE_FAILED" } });
  expect(postEditCalls).toBe(0);
});

function resourcePlugin(resolver: ResourceResolver): TextEditorPlugin {
  return {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "fixture-resource",
    setup(api) {
      api.addResolver({ resolver });
    },
  } as const;
}

function mutableResolver(read: () => string, write: (text: string) => void): ResourceResolver {
  return {
    id: "filesystem",
    async tryResolve(source) {
      if (source !== "notes.md") {
        return { kind: "not-handled" };
      }

      return {
        kind: "resolved",
        resource: {
          source: "/workspace/notes.md",
          async read() {
            return [{ type: "text", text: read() }];
          },
          async write(content: AgentContent) {
            const block = content[0];

            if (content.length !== 1 || block.type !== "text") {
              throw new Error("Expected one text block");
            }

            write(block.text);
          },
        },
      };
    },
  };
}

test("stateful resources can skip file post-edit processing inside a scope", async () => {
  const core = createTextEditorCore();
  let writes = 0;
  await core.registerPlugin(
    resourcePlugin({
      id: "terminal",
      async tryResolve() {
        return {
          kind: "resolved",
          resource: {
            source: "shell:fixture",
            skipPostEdit: true,
            async read() {
              return [{ type: "text" as const, text: "terminal input" }];
            },
            async write() {
              writes += 1;
            },
          },
        };
      },
    }),
  );
  let postEdits = 0;
  core.registerPostEditHandler({ id: "formatter", handler: () => void postEdits++ });
  const scope = createPostEditScope();

  await scope.run(() =>
    core.editText("shell:fixture", { cwd: "/workspace" }, () => ({
      text: "first input",
      result: null,
    })),
  );
  await scope.run(() =>
    core.editText("shell:fixture", { cwd: "/workspace" }, () => ({
      text: "second input",
      result: null,
    })),
  );

  expect(writes).toBe(2);
  expect(postEdits).toBe(0);
  await expect(scope.finish()).resolves.toEqual([]);
});

test("final processing of independent resources overlaps and returns outcomes in source order", async () => {
  const core = createTextEditorCore();
  const contents = new Map<string, string>();
  await core.registerPlugin(
    resourcePlugin({
      id: "memory",
      async tryResolve(source) {
        return {
          kind: "resolved",
          resource: {
            source: `memory:${source}`,
            async read() {
              return [{ type: "text", text: contents.get(source) ?? "before" }];
            },
            async write(content) {
              contents.set(source, (content[0] as { text: string }).text);
            },
          },
        };
      },
    }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  core.registerPostEditHandler({
    id: "gate",
    async handler(transaction) {
      started.push(transaction.source);
      if (transaction.source === "first.txt") await gate;
      else release();
    },
  });
  const scope = createPostEditScope();
  for (const source of ["first.txt", "second.txt"]) {
    await scope.run(() =>
      core.editText(source, { cwd: "/workspace" }, () => ({ text: "after", result: null })),
    );
  }
  const finishing = scope.finish();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcomes = await Promise.race([
      finishing,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Final processing was serialized")), 500);
      }),
    ]);
    expect(started).toEqual(["first.txt", "second.txt"]);
    expect(outcomes.map((outcome) => outcome.after.source)).toEqual([
      "memory:first.txt",
      "memory:second.txt",
    ]);
  } finally {
    clearTimeout(timer);
    release();
    await finishing;
  }
});
test("a post-edit scope writes immediately and processes each final file once", async () => {
  const core = createTextEditorCore();
  let text = "before";
  await core.registerPlugin(
    resourcePlugin(
      mutableResolver(
        () => text,
        (next) => {
          text = next;
        },
      ),
    ),
  );
  const processed: string[] = [];
  core.registerPostEditHandler({
    id: "formatter",
    handler() {
      processed.push(text);
      text = text.toUpperCase();
    },
  });
  const scope = createPostEditScope();
  await scope.run(() =>
    core.editText("notes.md", { cwd: "/workspace" }, () => ({ text: "first", result: null })),
  );
  expect(text).toBe("first");
  await scope.run(() =>
    core.editText("notes.md", { cwd: "/workspace" }, () => ({ text: "final", result: null })),
  );
  expect(processed).toEqual([]);
  const outcomes = await scope.finish();
  expect(processed).toEqual(["final"]);
  expect(text).toBe("FINAL");
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.after.content).toBe("FINAL");
  expect(await scope.finish()).toEqual([]);
});

test.each(["cancel", "external-write"])(
  "final processing protects %s without undoing the requested write",
  async (mode) => {
    const core = createTextEditorCore();
    let text = "before";
    await core.registerPlugin(
      resourcePlugin(
        mutableResolver(
          () => text,
          (next) => {
            text = next;
          },
        ),
      ),
    );
    let formatted = 0;
    core.registerPostEditHandler({
      id: "formatter",
      handler() {
        formatted++;
      },
    });
    const controller = new AbortController();
    const scope = createPostEditScope();
    await scope.run(() =>
      core.editText("notes.md", { cwd: "/workspace", signal: controller.signal }, () => ({
        text: "written",
        result: null,
      })),
    );
    if (mode === "cancel") {
      controller.abort();
      await scope.finish();
      expect(text).toBe("written");
    } else {
      text = "external";
      await expect(scope.finish()).rejects.toBeInstanceOf(AggregateError);
      expect(text).toBe("external");
    }
    expect(formatted).toBe(0);
  },
);
