import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { executeWholeFileTool } from "#src/core/file-operation-tools.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-approval-state-"));
  roots.push(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  await mkdir(path.join(cwd, "tracked"));
  await writeFile(path.join(cwd, "tracked", "data"), "keep");
  execFileSync("git", ["-C", cwd, "add", "tracked"]);
  return cwd;
}

test.each(["delete", "move"] as const)(
  "%s stays blocked only while its approval waits",
  async (operation) => {
    const cwd = await fixture();
    const emit = vi.fn();
    let answer!: (value: boolean) => void;
    let opened!: () => void;
    const pending = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const confirm = vi.fn(() => {
      opened();
      return pending;
    });
    const result = executeWholeFileTool(
      createTextEditorCore(),
      operation,
      operation === "move" ? { path: "tracked", target: "moved" } : { path: "tracked" },
      undefined,
      { cwd, mode: "tui", hasUI: true, ui: { confirm } },
      undefined,
      { emit },
    );
    try {
      await Promise.race([
        ready,
        result.then(() => {
          throw Error("Operation ended before the dialog opened");
        }),
      ]);
      expect(emit.mock.calls).toEqual([
        ["herdr:blocked", { active: true, label: expect.any(String) as unknown }],
      ]);
      expect(await readFile(path.join(cwd, "tracked", "data"), "utf8")).toBe("keep");
    } finally {
      answer(true);
    }
    expect((await result).details.metadata?.semanticAction).toMatchObject({
      ok: true,
      effect: "applied",
    });
    expect(emit.mock.calls).toEqual([
      ["herdr:blocked", { active: true, label: expect.any(String) as unknown }],
      ["herdr:blocked", { active: false }],
    ]);
    await expect(lstat(path.join(cwd, "tracked"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["refuse", "dismiss", "throw", "abort"] as const)(
  "releases blocked state after %s",
  async (ending) => {
    const cwd = await fixture();
    const emit = vi.fn();
    const controller = new AbortController();
    const confirm = vi.fn(async () => {
      if (ending === "throw") throw Error("dialog failed");
      if (ending === "abort") controller.abort();
      const answer = ending === "dismiss" ? undefined : false;
      return answer as boolean;
    });
    const run = executeWholeFileTool(
      createTextEditorCore(),
      "delete",
      { path: "tracked" },
      controller.signal,
      { cwd, mode: "tui", hasUI: true, ui: { confirm } },
      undefined,
      { emit },
    );
    expect((await run).details.metadata?.semanticAction).toMatchObject({
      ok: false,
      effect: "not-applied",
    });
    expect(emit.mock.calls).toEqual([
      ["herdr:blocked", { active: true, label: expect.any(String) as unknown }],
      ["herdr:blocked", { active: false }],
    ]);
    expect(await readFile(path.join(cwd, "tracked", "data"), "utf8")).toBe("keep");
  },
);

test("Herdr listener failures do not change a user approval", async () => {
  const cwd = await fixture();
  const emit = vi.fn(() => {
    throw Error("Herdr unavailable");
  });
  const confirm = vi.fn(async () => true);
  const result = await executeWholeFileTool(
    createTextEditorCore(),
    "delete",
    { path: "tracked" },
    undefined,
    { cwd, mode: "tui", hasUI: true, ui: { confirm } },
    undefined,
    { emit },
  );
  expect(result.details.metadata?.semanticAction).toMatchObject({ ok: true, effect: "applied" });
  expect(confirm).toHaveBeenCalledOnce();
  expect(emit).toHaveBeenCalledTimes(2);
});

test("does not mark absent, protected, auto-allowed, Copy, or non-TUI dialogs blocked", async () => {
  const cwd = await fixture();
  const emit = vi.fn();
  const confirm = vi.fn(async () => false);
  const core = createTextEditorCore();
  await mkdir(path.join(cwd, "untracked"));
  for (const [operation, input] of [
    ["delete", { path: ".git" }],
    ["delete", { path: "untracked" }],
    ["copy", { path: "tracked", target: "copy" }],
  ] as const) {
    await executeWholeFileTool(
      core,
      operation,
      input,
      undefined,
      { cwd, mode: "tui", hasUI: true, ui: { confirm } },
      undefined,
      { emit },
    );
  }
  expect(confirm).not.toHaveBeenCalled();
  for (const mode of ["rpc", "json", "print"] as const) {
    await executeWholeFileTool(
      core,
      "delete",
      { path: "tracked" },
      undefined,
      { cwd, mode, hasUI: mode === "rpc", ui: { confirm } },
      undefined,
      { emit },
    );
  }
  expect(confirm).toHaveBeenCalledOnce();
  expect(emit).not.toHaveBeenCalled();
});
