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
