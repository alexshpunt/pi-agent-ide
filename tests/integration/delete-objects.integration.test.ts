import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.js";

test("requires host user decisions for tracked deletion through direct and native Codemode calls", async () => {
  await withTempWorkspace(async (cwd) => {
    execFileSync("git", ["init", "-q", cwd]);
    await enableNativeCodemode(cwd);
    const targets = [
      "direct-tracked-no",
      "direct-tracked-yes",
      "script-tracked-no",
      "script-tracked-yes",
    ];
    for (const target of targets) {
      await mkdir(path.join(cwd, target));
      await writeFile(path.join(cwd, target, "data"), "tracked");
    }
    execFileSync("git", ["-C", cwd, "add", ...targets]);
    const run = await new PiIntegrationTest({
      testName: "delete-tracked-host-decisions",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        "builtin:codemode",
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/user-hooks-extension.ts"),
        path.resolve("tests/integration/support/delete-dialog-extension.ts"),
      ],
      tools: ["delete", "codemode"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "direct-no", name: "delete", arguments: { path: targets[0] } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "direct-yes", name: "delete", arguments: { path: targets[1] } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "script-no",
              name: "codemode",
              arguments: {
                code: 'let denied=false; try { await tools.delete({path:"script-tracked-no"}); } catch { denied=true; } if(!denied) throw Error("User refused"); text("refused");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "script-yes",
              name: "codemode",
              arguments: { code: 'text(await tools.delete({path:"script-tracked-yes"}));' },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Delete only tracked targets approved by the user");
    expect(getToolExecution(run, "direct-no").isError).toBe(true);
    for (const id of ["direct-yes", "script-no", "script-yes"])
      expect(getToolExecution(run, id).isError).toBe(false);
    for (const target of ["direct-tracked-no", "script-tracked-no"])
      expect(await readFile(path.join(cwd, target, "data"), "utf8")).toBe("tracked");
    for (const target of ["direct-tracked-yes", "script-tracked-yes"])
      await expect(lstat(path.join(cwd, target))).rejects.toMatchObject({ code: "ENOENT" });
    const decisions = (await readFile(path.join(cwd, "dialog-decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message: string; approved: boolean });
    expect(decisions.map(({ approved }) => approved)).toEqual([false, true, false, true]);
    expect(decisions.map(({ message }) => path.basename(message.split("\n")[0] ?? ""))).toEqual(
      targets,
    );
    expect(decisions.every(({ message }) => path.isAbsolute(message.split("\n")[0] ?? ""))).toBe(
      true,
    );
  });
});

// This proves the real extension registration and both call routes. Dialog decisions have focused
// adapter coverage; the actual dialog is checked live in the working Pi session.
test("deletes filesystem objects and fails closed on deletion hooks through both routes", async () => {
  await withTempWorkspace(async (cwd) => {
    execFileSync("git", ["init", "-q", cwd]);
    await enableNativeCodemode(cwd);
    const names = ["untracked", "script-untracked", "locked-delete", "throw-delete"];
    for (const name of names) {
      await mkdir(path.join(cwd, name));
      await writeFile(path.join(cwd, name, "data"), "keep");
    }
    await writeFile(path.join(cwd, "sentinel"), "untouched");
    await symlink("sentinel", path.join(cwd, "link"));
    await symlink("missing", path.join(cwd, "broken"));
    await symlink("sentinel", path.join(cwd, "untracked", "link"));
    await writeFile(path.join(cwd, "locked-file-locked-delete"), "keep");
    await writeFile(path.join(cwd, "selected-locked-delete"), "remove this text");
    const calls = [
      toolCall({ id: "delete-dir", name: "delete", arguments: { path: "untracked" } }),
      toolCall({ id: "delete-link", name: "delete", arguments: { path: "link" } }),
      toolCall({ id: "delete-broken", name: "delete", arguments: { path: "broken" } }),
      toolCall({ id: "delete-locked", name: "delete", arguments: { path: "locked-delete" } }),
      toolCall({ id: "delete-throws", name: "delete", arguments: { path: "throw-delete" } }),
      toolCall({
        id: "delete-locked-file",
        name: "delete",
        arguments: { path: "locked-file-locked-delete" },
      }),
      toolCall({ id: "delete-protected", name: "delete", arguments: { path: ".git/config" } }),
      toolCall({
        id: "script-deletion",
        name: "codemode",
        arguments: {
          code: 'for (const path of ["locked-delete", "throw-delete", ".git"]) { let rejected=false; try { await tools.delete({path}); } catch { rejected=true; } if(!rejected) throw Error("Delete must reject " + path); } text(await tools.delete({path:"script-untracked"}));',
        },
      }),
      toolCall({
        id: "script-selection",
        name: "codemode",
        arguments: {
          code: 'const selected=await tools.read({path:"selected-locked-delete"}); text(await tools.delete({path:selected}));',
        },
      }),
    ];
    const run = await new PiIntegrationTest({
      testName: "delete-objects-hooks",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        "builtin:codemode",
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/user-hooks-extension.ts"),
      ],
      tools: ["delete", "read", "codemode"],
      conversation: [
        ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
        assistantMessage([text("Done")]),
      ],
    }).run("Exercise whole-object deletion and selected-text removal");
    for (const id of [
      "delete-dir",
      "delete-link",
      "delete-broken",
      "script-deletion",
      "script-selection",
    ])
      expect(getToolExecution(run, id).isError).toBe(false);
    for (const id of ["delete-locked", "delete-throws", "delete-locked-file", "delete-protected"])
      expect(getToolExecution(run, id).isError).toBe(true);
    expect(getToolResultText(run, "delete-locked")).toContain("fixture deletion lock");
    expect(getToolResultText(run, "delete-throws")).toContain("delete hook exploded");
    expect(getToolResultText(run, "delete-protected")).toContain("DELETE_PROTECTED_TARGET");
    for (const name of ["untracked", "script-untracked", "link", "broken"])
      await expect(lstat(path.join(cwd, name))).rejects.toMatchObject({ code: "ENOENT" });
    for (const name of ["locked-delete", "throw-delete"])
      expect(await readFile(path.join(cwd, name, "data"), "utf8")).toBe("keep");
    expect(await readFile(path.join(cwd, "locked-file-locked-delete"), "utf8")).toBe("keep");
    expect(await readFile(path.join(cwd, "sentinel"), "utf8")).toBe("untouched");
    expect(await readFile(path.join(cwd, "selected-locked-delete"), "utf8")).toBe("");
  });
});
