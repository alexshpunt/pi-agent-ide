import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackend } from "#src/backend/ssh.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("real Pi reads and edits SSH resources without a separate tool workflow", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-resource-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  try {
    const backend = new SshBackend({
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    });
    for (const name of ["note.txt", "conflict.txt"])
      await backend.write(path.join(fixture.workspace, name), Buffer.from("before\n"), null);
    const notePath = path.join(fixture.workspace, "note.txt");
    const linkedNote = `${notePath}.alias`;
    await link(notePath, linkedNote);
    const noteInode = (await stat(notePath)).ino;
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: [
          "ide.ast",
          "ide.lsp",
          "ide.formatter",
          "ide.lint",
          "ide.diagnostics",
          "ide.debugger",
          "ide.terminal",
          "ide.vision",
        ],
      }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [backend.target] }),
    );
    await backend.write(
      path.join(fixture.workspace, "bytes.bin"),
      Buffer.from([0, 255, 239, 187, 191, 13, 10, 65]),
      null,
    );
    const largePath = path.join(fixture.workspace, "large-journal.bin");
    const large = `ssh://fixture${largePath}`;
    const largeCopy = `ssh://fixture${fixture.workspace}/large-copy.bin`;
    const largeBytes = Buffer.alloc(33 * 1024 * 1024 + 3, 255);
    largeBytes.set([0, 239, 187, 191, 13, 10]);
    const largeDigest = createHash("sha256").update(largeBytes).digest("hex");
    await writeFile(largePath, largeBytes);
    const raw = `raw:ssh://fixture${fixture.workspace}/bytes.bin`;
    const binary = `ssh://fixture${fixture.workspace}/bytes.bin`;
    const copied = `ssh://fixture${fixture.workspace}/copied.bin`;
    const moved = `ssh://fixture${fixture.workspace}/moved.bin`;
    const note = `ssh://fixture${fixture.workspace}/note.txt`;
    const conflict = `ssh://fixture${fixture.workspace}/conflict.txt`;
    const applyCreated = `ssh://fixture${fixture.workspace}/apply-created.txt`;
    const applyCopy = `ssh://fixture${fixture.workspace}/apply-copy.bin`;
    const local = path.join(cwd, "local.txt");
    const uploaded = `ssh://fixture${fixture.workspace}/uploaded-local.txt`;
    const downloaded = path.join(cwd, "downloaded.bin");
    await writeFile(local, "local before");
    const run = await new PiIntegrationTest({
      testName: "ssh-resource-tools",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      environment: {
        IDE_SSH_FIXTURE_WORKSPACE: fixture.workspace,
        IDE_SSH_FIXTURE_CONFIG: fixture.config,
      },
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/ssh-resources.ts"),
        "builtin:codemode",
      ],
      tools: ["read", "replace", "copy", "move", "delete", "write", "codemode"],
      // Large transfers stay on their selected owners without a controller text snapshot.
      timeoutMs: 240000,
      conversation: [
        assistantMessage([
          toolCall({ id: "ssh-guide", name: "read", arguments: { path: "docs:ssh" } }),
        ]),
        assistantMessage([
          toolCall({ id: "copy-bytes", name: "copy", arguments: { path: binary, target: copied } }),
        ]),
        assistantMessage([
          toolCall({
            id: "copy-existing",
            name: "copy",
            arguments: { path: binary, target: copied },
          }),
        ]),
        assistantMessage([
          toolCall({ id: "move-bytes", name: "move", arguments: { path: copied, target: moved } }),
        ]),
        assistantMessage([
          toolCall({ id: "read-moved-bytes", name: "read", arguments: { path: `raw:${moved}` } }),
        ]),
        assistantMessage([
          toolCall({ id: "delete-moved-bytes", name: "delete", arguments: { path: moved } }),
        ]),
        assistantMessage([
          toolCall({ id: "read-bytes", name: "read", arguments: { path: raw } }),
          toolCall({
            id: "read-byte-tail",
            name: "read",
            arguments: { path: raw, offset: -3, limit: 2 },
          }),
          toolCall({ id: "read-byte-empty", name: "read", arguments: { path: raw, limit: 0 } }),
          toolCall({
            id: "raw-views-rejected",
            name: "read",
            arguments: { path: raw, views: ["anchors"] },
          }),
        ]),
        assistantMessage(
          [
            toolCall({
              id: "read-note",
              name: "read",
              arguments: { path: note, views: ["anchors"] },
            }),
            toolCall({
              id: "read-conflict",
              name: "read",
              arguments: { path: conflict, views: ["anchors"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "edit-note",
              name: "replace",
              arguments: { path: note, start: "before", text: "after" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "edit-conflict",
              name: "replace",
              arguments: { path: conflict, start: "before", text: "must-not-overwrite" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({ id: "reread-note", name: "read", arguments: { path: note } }),
            toolCall({ id: "reread-conflict", name: "read", arguments: { path: conflict } }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([
          toolCall({
            id: "mixed-transfers",
            name: "codemode",
            arguments: {
              code: `
text(await tools.write({path:${JSON.stringify(applyCreated)},content:"created remotely"}));
for (const [path,target] of ${JSON.stringify([
                [binary, applyCopy],
                [local, uploaded],
                [binary, downloaded],
                [large, largeCopy],
              ])}) text(await tools.copy({path,target}));
text(await tools.delete({path:${JSON.stringify(large)}}));
`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({ id: "read-applied-note", name: "read", arguments: { path: note } }),
          toolCall({
            id: "read-applied-binary",
            name: "read",
            arguments: { path: `raw:${applyCopy}` },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "cleanup-transfers",
            name: "codemode",
            arguments: {
              code: `
text(await tools.move({path:${JSON.stringify(largeCopy)},target:${JSON.stringify(large)}}));
for (const path of ${JSON.stringify([applyCreated, applyCopy, uploaded, downloaded])}) text(await tools.delete({path}));
`,
            },
          }),
        ]),
        assistantMessage([text("Finished")]),
      ],
    }).run("Use the existing read and replace tools on the configured SSH resources.");
    for (const id of ["read-note", "read-conflict", "edit-note", "reread-note", "reread-conflict"])
      expect(getToolExecution(run, id).isError).toBe(false);
    expect(getToolExecution(run, "edit-conflict").isError).toBe(true);
    for (const id of ["copy-bytes", "move-bytes", "read-moved-bytes", "delete-moved-bytes"])
      expect(getToolExecution(run, id).isError).toBe(false);
    expect(
      getToolExecution(run, "copy-existing").isError,
      getToolResultText(run, "copy-existing"),
    ).toBe(false);
    expect(getToolResultText(run, "read-moved-bytes")).toContain("00 ff ef bb bf 0d 0a 41");
    await expect(readFile(path.join(fixture.workspace, "copied.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(fixture.workspace, "moved.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(getToolExecution(run, "ssh-guide").isError).toBe(false);
    expect(getToolResultText(run, "ssh-guide")).toContain(`ssh://fixture${fixture.workspace}`);
    for (const id of ["read-bytes", "read-byte-tail", "read-byte-empty"])
      expect(getToolExecution(run, id).isError).toBe(false);
    expect(getToolResultText(run, "read-bytes")).toContain("00 ff ef bb bf 0d 0a 41");
    expect(getToolResultText(run, "read-byte-tail")).toContain("00000005  0d 0a");
    expect(getToolResultText(run, "read-byte-empty")).toContain("Bytes 0..0");
    expect(getToolExecution(run, "raw-views-rejected").isError).toBe(true);
    expect(getToolResultText(run, "reread-note")).toContain("after");
    expect(getToolResultText(run, "reread-conflict")).toContain("external");
    expect(await readFile(path.join(fixture.workspace, "note.txt"), "utf8")).toBe("after\n");
    expect(await readFile(path.join(fixture.workspace, "conflict.txt"), "utf8")).toBe("external\n");
    expect(
      getToolExecution(run, "mixed-transfers").isError,
      getToolResultText(run, "mixed-transfers"),
    ).toBe(false);
    for (const source of [applyCopy, uploaded, downloaded])
      expect(getToolResultText(run, "mixed-transfers")).toContain(source);
    expect(
      getToolExecution(run, "cleanup-transfers").isError,
      getToolResultText(run, "cleanup-transfers"),
    ).toBe(false);
    expect(getToolResultText(run, "read-applied-note")).toContain("after");
    expect(getToolResultText(run, "read-applied-binary")).toContain("00 ff ef bb bf 0d 0a 41");
    expect(await readFile(local, "utf8")).toBe("local before");
    expect(await readFile(linkedNote, "utf8")).toBe("after\n");
    expect((await stat(notePath)).ino).toBe(noteInode);
    expect((await stat(linkedNote)).ino).toBe(noteInode);
    expect(
      createHash("sha256")
        .update(await readFile(largePath))
        .digest("hex"),
    ).toBe(largeDigest);
    await expect(readFile(path.join(fixture.workspace, "large-copy.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(downloaded)).rejects.toMatchObject({ code: "ENOENT" });
    for (const name of ["apply-created.txt", "apply-copy.bin", "uploaded-local.txt"])
      await expect(readFile(path.join(fixture.workspace, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(run.tuiRenderedOutput).toContain("ssh://fixture");
    expect(getToolResultText(run, "ssh-guide")).not.toContain(fixture.config);
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 270000);
