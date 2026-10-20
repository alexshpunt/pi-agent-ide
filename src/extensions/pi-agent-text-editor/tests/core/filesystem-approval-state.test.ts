import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { executeWholeFileTool } from "#src/core/file-operation-tools.js";
import {
  createOperationApproval,
  OPERATION_APPROVAL_EVENT,
  type OperationApprovalRequest,
} from "pi-agent-tool-ui/operation-approval";

function approvalEvents(emit: (name: string, data: unknown) => void) {
  const service = createOperationApproval({ emit });
  return {
    emit(name: string, data: unknown): void {
      if (name === OPERATION_APPROVAL_EVENT) service.handle(data);
      else emit(name, data);
    },
  };
}

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
    const select = vi.fn(() => {
      opened();
      return pending.then((value) => (value ? "Allow once" : "Deny"));
    });
    const result = executeWholeFileTool(
      createTextEditorCore(),
      operation,
      operation === "move" ? { path: "tracked", target: "moved" } : { path: "tracked" },
      undefined,
      { cwd, mode: "tui", hasUI: true, ui: { select } },
      undefined,
      approvalEvents(emit),
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
    const select = vi.fn(async () => {
      if (ending === "throw") throw Error("dialog failed");
      if (ending === "abort") controller.abort();
      return ending === "dismiss" ? undefined : "Deny";
    });
    const run = executeWholeFileTool(
      createTextEditorCore(),
      "delete",
      { path: "tracked" },
      controller.signal,
      { cwd, mode: "tui", hasUI: true, ui: { select } },
      undefined,
      approvalEvents(emit),
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

test.each(["delete", "move"] as const)(
  "YOLO permits headless %s but not protected targets",
  async (operation) => {
    const cwd = await fixture();
    const emit = vi.fn();
    const policy = vi.fn(async (_request: OperationApprovalRequest) => true);
    const service = createOperationApproval({ emit }, { isAllowed: policy });
    const events = {
      emit(name: string, data: unknown) {
        if (name === OPERATION_APPROVAL_EVENT) service.handle(data);
        else emit(name, data);
      },
    };
    const core = createTextEditorCore();
    const context = { cwd, mode: "print" as const, hasUI: false };
    const result = await executeWholeFileTool(
      core,
      operation,
      operation === "move" ? { path: "tracked", target: "moved" } : { path: "tracked" },
      undefined,
      context,
      undefined,
      events,
    );
    expect(result.details.metadata?.semanticAction).toMatchObject({ ok: true, effect: "applied" });
    expect(policy).toHaveBeenCalledOnce();
    expect(policy.mock.calls[0]?.[0]).toMatchObject({
      owner: "pi-agent-ide",
      category: operation,
      yoloSetting: "pi-agent-ide-filesystem-yolo",
    });
    const protectedResult = await executeWholeFileTool(
      core,
      "delete",
      { path: ".git/config" },
      undefined,
      context,
      undefined,
      events,
    );
    expect(protectedResult.details.metadata?.semanticAction).toMatchObject({
      ok: false,
      effect: "not-applied",
    });
    expect(policy).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
    await expect(lstat(path.join(cwd, "tracked"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(cwd, ".git/config"), "utf8")).toContain("[core]");
    service.dispose();
  },
);
test("Herdr listener failures do not change a user approval", async () => {
  const cwd = await fixture();
  const emit = vi.fn(() => {
    throw Error("Herdr unavailable");
  });
  const select = vi.fn(async () => "Allow once");
  const result = await executeWholeFileTool(
    createTextEditorCore(),
    "delete",
    { path: "tracked" },
    undefined,
    { cwd, mode: "tui", hasUI: true, ui: { select } },
    undefined,
    approvalEvents(emit),
  );
  expect(result.details.metadata?.semanticAction).toMatchObject({ ok: true, effect: "applied" });
  expect(select).toHaveBeenCalledOnce();
  expect(emit).toHaveBeenCalledTimes(2);
});

test("does not mark absent, protected, auto-allowed, Copy, or non-TUI dialogs blocked", async () => {
  const cwd = await fixture();
  const emit = vi.fn();
  const select = vi.fn(async () => "Deny");
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
      { cwd, mode: "tui", hasUI: true, ui: { select } },
      undefined,
      approvalEvents(emit),
    );
  }
  expect(select).not.toHaveBeenCalled();
  for (const mode of ["rpc", "json", "print"] as const) {
    await executeWholeFileTool(
      core,
      "delete",
      { path: "tracked" },
      undefined,
      { cwd, mode, hasUI: mode === "rpc", ui: { select } },
      undefined,
      approvalEvents(emit),
    );
  }
  expect(select).toHaveBeenCalledOnce();
  expect(emit).not.toHaveBeenCalled();
});
