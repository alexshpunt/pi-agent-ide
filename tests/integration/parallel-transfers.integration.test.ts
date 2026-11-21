import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const extensions = [path.resolve("src/pi-agent-ide.ts")];

test("parallel whole-object transfers keep each filesystem refusal and leave bytes unchanged", async () => {
  await withTempWorkspace(async (cwd) => {
    execFileSync("git", ["init", "-q", cwd]);
    for (const directory of ["source-tree", "tracked"]) await mkdir(path.join(cwd, directory));
    await writeFile(path.join(cwd, "source-tree/data"), "SOURCE\n");
    await writeFile(path.join(cwd, "tracked/data"), "KEEP\n");
    await writeFile(path.join(cwd, "sentinel"), "SENTINEL\n");
    await symlink("sentinel", path.join(cwd, "link"));
    execFileSync("git", ["-C", cwd, "add", "tracked/data"]);
    const gitConfig = await readFile(path.join(cwd, ".git/config"));
    const transfers = [
      { name: "copy", path: "source-tree", target: "source-tree/new", code: "OVERLAPPING_PATHS" },
      { name: "copy", path: "source-tree", target: "link", code: "INVALID_FILE_TYPE" },
      { name: "move", path: "tracked", target: "new-target", code: "DELETE_NOT_APPROVED" },
      { name: "move", path: "source-tree", target: ".git", code: "DELETE_PROTECTED_TARGET" },
    ];
    const run = await new PiIntegrationTest({
      testName: "parallel-directory-transfer-refusals",
      rawMode: false,
      tuiSize: { cols: 160, rows: 50 },
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        ...extensions,
        path.resolve("tests/integration/support/delete-dialog-extension.ts"),
      ],
      tools: ["copy", "move"],
      conversation: [
        assistantMessage(
          transfers.map(({ name, path: source, target }, index) =>
            toolCall({ id: `transfer-${index}`, name, arguments: { path: source, target } }),
          ),
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Attempt the four independent directory transfers in one assistant message");
    for (const [index, transfer] of transfers.entries()) {
      const call = getToolExecution(run, `transfer-${index}`);
      expect(call.isError).toBe(true);
      expect(getToolExecutionDetails(call)).toMatchObject({
        metadata: {
          semanticAction: {
            kind: "file-operation",
            operation: transfer.name,
            path: path.join(cwd, transfer.path),
            target: path.join(cwd, transfer.target),
            ok: false,
            effect: "not-applied",
            error: { code: transfer.code },
          },
        },
      });
    }
    expect(await readFile(path.join(cwd, "source-tree/data"), "utf8")).toBe("SOURCE\n");
    expect(await readFile(path.join(cwd, "tracked/data"), "utf8")).toBe("KEEP\n");
    expect(await readFile(path.join(cwd, "sentinel"), "utf8")).toBe("SENTINEL\n");
    expect(await readlink(path.join(cwd, "link"))).toBe("sentinel");
    expect(await readFile(path.join(cwd, ".git/config"))).toEqual(gitConfig);
    for (const absent of ["source-tree/new", "new-target"])
      await expect(lstat(path.join(cwd, absent))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("whole-object transfers split text batches without changing file, tree or link semantics", async () => {
  await withTempWorkspace(async (cwd) => {
    execFileSync("git", ["init", "-q", cwd]);
    for (const directory of ["copy-tree/nested", "copied-tree", "move-tree/empty", "moved-tree"])
      await mkdir(path.join(cwd, directory), { recursive: true });
    const bytes = Buffer.from([0, 255, 13, 10, 128]);
    for (const file of ["copy.bin", "move.bin", "copy-tree/nested/data.bin", "move-tree/data.bin"])
      await writeFile(path.join(cwd, file), bytes);
    await writeFile(path.join(cwd, "copied-tree/keep"), "keep");
    await writeFile(path.join(cwd, "moved-tree/remove"), "remove");
    await writeFile(path.join(cwd, "sentinel"), "untouched");
    for (const link of ["copy-link", "move-link"]) await symlink("sentinel", path.join(cwd, link));
    await writeFile(path.join(cwd, "edited.txt"), "alpha\nbeta\nomega\n");
    await writeFile(path.join(cwd, "ranges.txt"), "copy-me\nmove-me\nkeep\nomega\n");
    const transfers = [
      { name: "copy", path: "copy.bin", target: "copied.bin", sourceKind: "file" },
      { name: "move", path: "move.bin", target: "moved.bin", sourceKind: "file" },
      { name: "copy", path: "copy-tree", target: "copied-tree", sourceKind: "directory" },
      { name: "move", path: "move-tree", target: "moved-tree", sourceKind: "directory" },
      { name: "copy", path: "copy-link", target: "copied-link", sourceKind: "symlink" },
      { name: "move", path: "move-link", target: "moved-link", sourceKind: "symlink" },
    ];
    const calls = [
      toolCall({
        id: "replace-alpha",
        name: "replace",
        arguments: { path: "edited.txt", at: "alpha", text: "ALPHA" },
      }),
      toolCall({
        id: "replace-beta",
        name: "replace",
        arguments: { path: "edited.txt", at: "beta", text: "BETA" },
      }),
      ...transfers.map(({ name, path: source, target }, index) =>
        toolCall({ id: `object-${index}`, name, arguments: { path: source, target } }),
      ),
      toolCall({
        id: "copy-range",
        name: "copy",
        // Literals select only their characters; the line breaks make these whole-line transfers.
        arguments: { path: "ranges.txt", at: "copy-me\n", targetAfter: "omega\n" },
      }),
      toolCall({
        id: "move-range",
        name: "move",
        arguments: { path: "ranges.txt", at: "move-me\n", targetAfter: "keep\n" },
      }),
    ];
    const run = await new PiIntegrationTest({
      testName: "parallel-mixed-object-text-transfers",
      // Standalone TUI preserves symlink objects without shared-workspace copying.
      tuiSize: { cols: 160, rows: 50 },
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions,
      tools: ["copy", "move", "replace"],
      conversation: [
        assistantMessage(calls, { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Transfer independent filesystem objects between two groups of text edits");
    for (const call of calls) expect(getToolExecution(run, call.id).isError).toBe(false);
    for (const [index, transfer] of transfers.entries())
      expect(getToolExecutionDetails(getToolExecution(run, `object-${index}`))).toMatchObject({
        metadata: {
          semanticAction: {
            kind: "file-operation",
            operation: transfer.name,
            sourceKind: transfer.sourceKind,
            ok: true,
            effect: "applied",
          },
        },
      });
    for (const file of [
      "copy.bin",
      "copied.bin",
      "moved.bin",
      "copy-tree/nested/data.bin",
      "copied-tree/nested/data.bin",
      "moved-tree/data.bin",
    ])
      expect(await readFile(path.join(cwd, file))).toEqual(bytes);
    expect(await readFile(path.join(cwd, "copied-tree/keep"), "utf8")).toBe("keep");
    expect((await lstat(path.join(cwd, "moved-tree/empty"))).isDirectory()).toBe(true);
    for (const absent of ["move.bin", "move-tree", "move-link", "moved-tree/remove"])
      await expect(lstat(path.join(cwd, absent))).rejects.toMatchObject({ code: "ENOENT" });
    for (const link of ["copy-link", "copied-link", "moved-link"])
      expect(await readlink(path.join(cwd, link))).toBe("sentinel");
    expect(await readFile(path.join(cwd, "sentinel"), "utf8")).toBe("untouched");
    expect(await readFile(path.join(cwd, "edited.txt"), "utf8")).toBe("ALPHA\nBETA\nomega\n");
    expect(await readFile(path.join(cwd, "ranges.txt"), "utf8")).toBe(
      "copy-me\nkeep\nmove-me\nomega\ncopy-me\n",
    );
  });
});
