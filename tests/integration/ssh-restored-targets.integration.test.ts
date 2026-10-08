import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionResult,
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

test("whole-file transfers and checkpoint restore publish only present native destination text", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-restored-targets");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const root = `ssh://fixture${fixture.workspace}`;
  const local = path.join(cwd, "source.txt");
  const copied = `${root}/copied.txt`;
  const moved = `${root}/moved.txt`;
  const created = `${root}/created.txt`;
  const original = "\ufeffprior café\r\n";
  try {
    await writeFile(local, original);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [backend.target] }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: [
          "ide.lsp",
          "ide.formatter",
          "ide.lint",
          "ide.debugger",
          "ide.terminal",
          "ide.vision",
          "ide.diagnostics",
        ],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-restored-targets",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/support/restore-target-extension.ts"),
      ],
      tools: ["read", "search", "copy", "move", "apply", "undo", "codemode"],
      timeoutMs: 150000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "transfers",
            name: "codemode",
            arguments: {
              code: `
const source = await tools.read({path:${JSON.stringify(local)}});
const copied = await tools.copy({path:source,target:${JSON.stringify(copied)}});
if(copied.status !== "success" || typeof copied.data.target !== "string") throw Error(JSON.stringify(copied));
const copiedText = await tools.search({path:copied,query:"café"});
if(copiedText.status !== "success" || copiedText.data.matches.length !== 1) throw Error(JSON.stringify(copiedText));
const moved = await tools.move({path:copied,target:${JSON.stringify(moved)}});
if(moved.status !== "success" || typeof moved.data.target !== "string") throw Error(JSON.stringify(moved));
const movedText = await tools.search({path:moved,query:"café"});
if(movedText.status !== "success" || movedText.data.matches.length !== 1 || movedText.data.matches[0].source !== ${JSON.stringify(moved)}) throw Error(JSON.stringify(movedText));
text({copied,moved});`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "checkpoint",
            name: "apply",
            arguments: {
              source: `const note = open(${JSON.stringify(moved)}); note.replace(note.find("prior"), "changed"); createFile(${JSON.stringify(created)}, "created café");`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "restore",
            name: "undo",
            arguments: { transaction: "APPLY#000000000000" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "restored-scope",
            name: "codemode",
            arguments: {
              code: `
const found = await tools.search({path:"owned-restored-target",query:"prior"});
if(found.status !== "success" || found.data.matches.length !== 1 || found.data.matches[0].source !== ${JSON.stringify(moved)}) throw Error(JSON.stringify(found));
text(found);`,
            },
          }),
        ]),
        assistantMessage([
          text("Restored present text retained native authority; restored absence has no target."),
        ]),
      ],
    }).run("Keep whole-file transfer bytes and restored source authority on their native owners.");
    for (const id of ["transfers", "checkpoint", "restore", "restored-scope"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(
      (await backend.read(`${fixture.workspace}/moved.txt`)).bytes.equals(Buffer.from(original)),
    ).toBe(true);
    await expect(backend.read(`${fixture.workspace}/copied.txt`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(backend.read(`${fixture.workspace}/created.txt`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(local, "utf8")).toBe(original);
    const receipt = getToolExecutionResult(run, "restore") as { structuredContent: unknown };
    expect(receipt.structuredContent).toMatchObject({
      status: "success",
      data: {
        effect: "applied",
        files: [
          { source: moved, effect: "applied", state: "present" },
          { source: created, effect: "applied", state: "absent" },
        ],
      },
    });
    const restoreText = getToolResultText(run, "restore");
    expect(restoreText).toContain("Restored 2 paths");
    expect(run.tuiRenderedOutput).toContain(root);
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 180000);
