import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
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
import { editDenial } from "#integration/support/file-hook-events-extension.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.ts";

test("file hooks block resolved access and report saved-edit feedback", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(path.join(cwd, "secret.txt"), "do not expose");
    await writeFile(path.join(cwd, "locked.txt"), "unchanged");
    await writeFile(path.join(cwd, "throw.txt"), "hidden");
    await writeFile(path.join(cwd, "fail-edit.txt"), "unchanged");
    const run = await new PiIntegrationTest({
      testName: "user-file-hooks",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        "builtin:codemode",
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/user-hooks-extension.ts"),
      ],
      tools: ["read", "codemode", "write", "replace"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "read-secret", name: "read", arguments: { path: "secret.txt" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-raw-secret",
              name: "read",
              arguments: { path: "raw:secret.txt" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-script-secret",
              name: "codemode",
              arguments: {
                code: 'const failure = await tools.read({path:"secret.txt"}); if(failure !== null) throw Error("Blocked read must resolve to null without content");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "read-throw", name: "read", arguments: { path: "throw.txt" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "edit-locked",
              name: "codemode",
              arguments: {
                code: 'text(await tools.replace({path:"locked.txt",at:"unchanged",text:"changed"}));',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "write-review",
              name: "write",
              arguments: { path: "review.txt", content: "needs review" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "write-after-fail",
              name: "write",
              arguments: { path: "after.txt", content: "explode-after" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "write-native-feedback",
              name: "codemode",
              arguments: {
                code: 'await tools.write({path:"native-review.txt",content:"needs review"}); await tools.write({path:"native-after.txt",content:"explode-after"});',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Exercise each file hook");

    expect(getToolExecution(run, "read-secret").isError).toBe(true);
    expect(getToolResultText(run, "read-secret")).toContain("fixture secret");
    expect(getToolExecution(run, "read-raw-secret").isError).toBe(true);
    expect(getToolResultText(run, "read-raw-secret")).toContain("fixture secret");
    expect(getToolExecution(run, "read-script-secret").isError).toBe(false);
    // The denial reaches the model in the script's failure block, without the file content.
    const denial = codemodeFailures(getToolResultText(run, "read-script-secret"));
    expect(denial).toMatch(/^1 of 1 IDE call failed:\n- read secret\.txt\n/u);
    expect(denial).toContain("fixture secret");
    expect(getToolResultText(run, "read-script-secret")).not.toContain("do not expose");
    expect(getToolExecution(run, "read-throw").isError).toBe(true);
    expect(getToolResultText(run, "read-throw")).toContain("read hook exploded");
    // A denied Read resolves to null and can continue; a blocked batch commit fails the parent script.
    expect(getToolExecution(run, "edit-locked").isError).toBe(true);
    expect(getToolResultText(run, "edit-locked")).toContain("fixture lock");
    expect(await readFile(path.join(cwd, "locked.txt"), "utf8")).toBe("unchanged");
    expect(getToolExecution(run, "write-review").isError).toBe(false);
    expect(await readFile(path.join(cwd, "review.txt"), "utf8")).toBe("needs review");
    expect(getToolResultText(run, "write-review")).toContain("Saved edit needs review");
    expect(getToolResultText(run, "write-review")).not.toContain(
      "Post-edit processing was interrupted or incomplete.",
    );
    expect(run.tuiRenderedOutput).toContain("Saved edit needs review");
    expect(getToolExecution(run, "write-after-fail").isError).toBe(false);
    expect(await readFile(path.join(cwd, "after.txt"), "utf8")).toBe("explode-after");
    expect(getToolResultText(run, "write-after-fail")).toContain("failed after the edit was saved");
    expect(run.tuiRenderedOutput).toContain("failed after the edit was saved");
    expect(getToolExecution(run, "write-native-feedback").isError).toBe(false);
    const nativeFeedback = getToolResultText(run, "write-native-feedback");
    expect(nativeFeedback).toContain("Saved edit needs review");
    expect(nativeFeedback).toContain("failed after the edit was saved");
    expect(nativeFeedback).not.toContain("interrupted or incomplete");
    expect(nativeFeedback).not.toContain("explode-after");
    expect(getToolResultText(run, "write-review")).not.toContain("interrupted or incomplete");
    expect(await readFile(path.join(cwd, "native-review.txt"), "utf8")).toBe("needs review");
    expect(await readFile(path.join(cwd, "native-after.txt"), "utf8")).toBe("explode-after");
  });
});

test("file hook plans describe the transaction and correlate its confirmed effects", async () => {
  await withTempWorkspace(async (cwd) => {
    execFileSync("git", ["init", "-q", cwd]);
    await enableNativeCodemode(cwd);
    for (const directory of [
      "source/nested",
      "copy-target",
      "move-target",
      "deny-target",
      "remove-dir",
    ])
      await mkdir(path.join(cwd, directory), { recursive: true });
    for (const [name, content] of Object.entries({
      "source/top.txt": "source top",
      "source/nested/empty.txt": "",
      "source/nested/binary": Buffer.from([0xff, 0x0a]),
      "source/protected.txt": "protected source",
      "copy-target/top.txt": "copy old",
      "copy-target/retain.txt": "retain",
      "move-target/top.txt": "move old",
      "move-target/obsolete.txt": "obsolete",
      "protected.txt": "protect me",
      "keep-delete": "keep me",
      "remove-dir/file": "remove me",
      "batch.txt": "before",
    }))
      await writeFile(path.join(cwd, name), content);
    // The allowed directory transfers omit the protected fixture.
    await mkdir(path.join(cwd, "allow/nested"), { recursive: true });
    await writeFile(path.join(cwd, "allow/top.txt"), "source top");
    await writeFile(path.join(cwd, "allow/nested/empty.txt"), "");
    await writeFile(path.join(cwd, "allow/nested/binary"), Buffer.from([0xff, 0x0a]));

    const calls = [
      toolCall({ id: "empty-write", name: "write", arguments: { path: "empty.txt", content: "" } }),
      toolCall({
        id: "write-denied",
        name: "write",
        arguments: { path: "protected.txt", content: "blocked" },
      }),
      toolCall({
        id: "replace-denied",
        name: "replace",
        arguments: { path: "protected.txt", at: "protect me", text: "blocked" },
      }),
      toolCall({
        id: "batch-denied",
        name: "codemode",
        arguments: {
          code: 'await tools.replace({path:"protected.txt",at:"protect me",text:"blocked"});',
        },
      }),
      toolCall({
        id: "tree-copy",
        name: "copy",
        arguments: { path: "allow", target: "copy-target" },
      }),
      toolCall({
        id: "tree-move",
        name: "move",
        arguments: { path: "allow", target: "move-target" },
      }),
      toolCall({
        id: "tree-copy-denied",
        name: "copy",
        arguments: { path: "source", target: "deny-target" },
      }),
      toolCall({
        id: "tree-move-denied",
        name: "move",
        arguments: { path: "source", target: "deny-target" },
      }),
      toolCall({ id: "empty-delete", name: "delete", arguments: { path: "empty.txt" } }),
      toolCall({ id: "delete-denied", name: "delete", arguments: { path: "keep-delete" } }),
      toolCall({
        id: "script",
        name: "codemode",
        arguments: {
          code: `
        await tools.write({path:"script-write.txt",content:"child"});
        await tools.replace({path:"batch.txt",at:"before",text:"after batch"});
        await tools.delete({path:"remove-dir"});
      `,
        },
      }),
    ];
    const run = await new PiIntegrationTest({
      testName: "file-hook-events",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        "builtin:codemode",
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/file-hook-events-extension.ts"),
      ],
      tools: ["codemode", "write", "replace", "copy", "move", "delete"],
      conversation: [
        ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
        assistantMessage([text("Done")]),
      ],
    }).run("Exercise file hook transaction and completion events");

    for (const id of [
      "write-denied",
      "replace-denied",
      "batch-denied",
      "tree-copy-denied",
      "tree-move-denied",
    ])
      expect(getToolResultText(run, id), id).toContain(editDenial);
    for (const id of ["empty-write", "tree-copy", "tree-move", "empty-delete", "script"])
      expect(getToolExecution(run, id).isError, id).toBe(false);
    const saved = (name: string) => readFile(path.join(cwd, name), "utf8");
    expect(await saved("protected.txt")).toBe("protect me");
    expect(await saved("source/protected.txt")).toBe("protected source");
    expect(await saved("keep-delete")).toBe("keep me");
    expect(await saved("copy-target/retain.txt")).toBe("retain");
    expect(await saved("copy-target/top.txt")).toBe("source top");
    expect(await saved("move-target/top.txt")).toBe("source top");
    expect(await saved("batch.txt")).toBe("after batch");
    for (const name of [
      "empty.txt",
      "remove-dir",
      "allow",
      "move-target/obsolete.txt",
      "deny-target/top.txt",
    ])
      await expect(lstat(path.join(cwd, name)), name).rejects.toMatchObject({ code: "ENOENT" });

    const events = (await saved("hook-events.jsonl"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            path?: string;
            toolCallId?: string;
            resources?: unknown[];
          },
      );
    const plan = (id: string) =>
      events.find(({ type, toolCallId }) => type === "before-edit" && toolCallId === id)?.resources;
    const change = (
      path: string,
      before: string | number[],
      after: string | number[],
      existed = true,
      deleted = false,
    ) => ({ path, before, after, existed, deleted });
    expect(plan("empty-write")).toEqual([change("empty.txt", "", "", false)]);
    expect(plan("empty-delete")).toEqual([change("empty.txt", "", "", true, true)]);
    expect(plan("tree-copy")).toEqual(
      expect.arrayContaining([
        change("copy-target/top.txt", "copy old", "source top"),
        change("copy-target/nested/empty.txt", "", "", false),
        change("copy-target/nested/binary", [], [0xff, 0x0a], false),
      ]),
    );
    expect(plan("tree-copy")).toHaveLength(3);
    expect(plan("tree-move")).toEqual(
      expect.arrayContaining([
        change("allow/top.txt", "source top", "", true, true),
        change("move-target/top.txt", "move old", "source top"),
        change("move-target/obsolete.txt", "obsolete", "", true, true),
        change("move-target/nested/empty.txt", "", "", false),
        change("move-target/nested/binary", [], [0xff, 0x0a], false),
      ]),
    );
    expect(plan("tree-move")).toHaveLength(7);
    for (const id of ["tree-copy-denied", "tree-move-denied"])
      expect(plan(id)).toContainEqual(
        change("deny-target/protected.txt", "", "protected source", false),
      );
    const childId = (path: string) => {
      const id = events.find((event) => event.type === "call" && event.path === path)?.toolCallId;
      if (id === undefined) throw new Error(`Missing invocation for ${path}`);
      expect(id).not.toBe("script");
      return id;
    };
    const childWrite = childId("script-write.txt");
    expect(plan(childWrite)).toEqual([change("script-write.txt", "", "child", false)]);
    expect(plan("script")).toEqual([change("batch.txt", "before", "after batch")]);
    expect(events.filter(({ type }) => type === "after-edit")).toEqual([
      { type: "after-edit", path: "empty.txt", toolCallId: "empty-write", content: "" },
      { type: "after-edit", path: "script-write.txt", toolCallId: childWrite, content: "child" },
      { type: "after-edit", path: "batch.txt", toolCallId: "script", content: "after batch" },
    ]);
    for (const [path, toolCallId, kind] of [
      ["empty.txt", "empty-delete", "file"],
      ["remove-dir", childId("remove-dir"), "directory"],
    ]) {
      const relevant = events.filter(
        (event) => event.path === path && event.type.endsWith("-delete"),
      );
      expect(relevant).toEqual([
        { type: "before-delete", path, toolCallId, kind },
        { type: "after-delete", path, toolCallId, kind, missing: true },
      ]);
    }
    expect(events.filter(({ type }) => type === "after-delete")).toHaveLength(2);
  });
});
