import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { executeWholeFileTool } from "#src/core/file-operation-tools.js";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-delete-tool-"));
  roots.push(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  await mkdir(path.join(cwd, "folder"));
  await writeFile(path.join(cwd, "folder", "data"), "keep");
  execFileSync("git", ["-C", cwd, "add", "folder/data"]);
  return cwd;
}

test("the host dialog names the target and refuses, dismisses, or approves removal", async () => {
  for (const answer of [false, undefined, true]) {
    const cwd = await fixture();
    const confirm = vi.fn(async () => answer as boolean);
    const result = await executeWholeFileTool(
      createTextEditorCore(),
      "delete",
      { path: "folder" },
      undefined,
      {
        cwd,
        hasUI: true,
        ui: { confirm },
      },
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]).toEqual([
      "Delete permanently?",
      expect.stringContaining(path.join(cwd, "folder")),
      { signal: undefined },
    ]);
    expect(result.details.metadata?.semanticAction).toMatchObject({
      ok: answer === true,
      effect: answer === true ? "applied" : "not-applied",
    });
    expect(result.details.results).toEqual([]);
    if (answer === true)
      await expect(lstat(path.join(cwd, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(path.join(cwd, "folder", "data"), "utf8")).toBe("keep");
  }
});

test("an allowing hook cannot bypass absent dialogs or protected Git data", async () => {
  const cwd = await fixture();
  const core = createTextEditorCore();
  await core.registerPlugin({
    id: "allow",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup: (api) => api.addDeleteGuard({ id: "allow", guard: () => ({ decision: "allow" }) }),
  });
  const noDialog = await executeWholeFileTool(core, "delete", { path: "folder" }, undefined, {
    cwd,
    hasUI: false,
  });
  expect(noDialog.details.metadata?.semanticAction).toMatchObject({
    ok: false,
    effect: "not-applied",
    error: { code: "DELETE_CONFIRMATION_REQUIRED" },
  });
  const protectedResult = await executeWholeFileTool(
    core,
    "delete",
    { path: ".git/config" },
    undefined,
    { cwd },
  );
  expect(protectedResult.details.metadata?.semanticAction).toMatchObject({
    ok: false,
    error: { code: "DELETE_PROTECTED_TARGET" },
  });
  expect(await readFile(path.join(cwd, "folder", "data"), "utf8")).toBe("keep");
});

test("denying or throwing hooks run before any host dialog", async () => {
  for (const throws of [false, true]) {
    const cwd = await fixture();
    const core = createTextEditorCore();
    const confirm = vi.fn(async () => true);
    const seen: string[] = [];
    await core.registerPlugin({
      id: "policies",
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      setup(api) {
        api.addDeleteGuard({
          id: "allow-first",
          guard(event) {
            seen.push(event.kind);
            return { decision: "allow" };
          },
        });
        api.addDeleteGuard({
          id: "block",
          guard() {
            if (throws) throw new Error("policy crashed");
            return { decision: "deny", reason: "policy lock" };
          },
        });
        api.addDeleteGuard({
          id: "not-reached",
          guard() {
            throw new Error("Should not reach this guard");
          },
        });
      },
    });
    const result = await executeWholeFileTool(core, "delete", { path: "folder" }, undefined, {
      cwd,
      hasUI: true,
      ui: { confirm },
    });
    expect(result.details.metadata?.semanticAction).toMatchObject({
      ok: false,
      effect: "not-applied",
      error: { code: "DELETE_HOOK_REJECTED" },
    });
    expect(seen).toEqual(["directory"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(await readFile(path.join(cwd, "folder", "data"), "utf8")).toBe("keep");
  }
});
