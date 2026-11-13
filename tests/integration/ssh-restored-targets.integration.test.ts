import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { startSshFixture } from "#integration/support/ssh-fixture.ts";
import { SshBackend } from "#src/backend/ssh.ts";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("whole-file transfers and last text undo publish only present native destination text", async () => {
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
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "copy", "move", "write", "delete", "undo", "codemode"],
      timeoutMs: 150000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "transfers",
            name: "codemode",
            arguments: {
              code: `
const source = await tools.read({path:${JSON.stringify(local)}});
// A refused IDE call resolves to null; the Codemode result lists its reason.
const transferRefused = (await tools.copy({path:source,target:${JSON.stringify(copied)}})) === null;
if (!transferRefused) throw Error("BOM conversion must not grant source coordinates");
const copied = await tools.copy({path:${JSON.stringify(local)},target:${JSON.stringify(copied)}});
const copiedBytes = await tools.read({path:${JSON.stringify("raw:" + copied)},limit:3});
// "77u/" is the base64 of the UTF-8 BOM, ef bb bf.
if (copiedBytes?.bytes !== "77u/") throw Error("Copy lost the UTF-8 BOM: " + JSON.stringify(copiedBytes));
const copiedText = await tools.search({path:copied,query:"café"});
if (copiedText.matches.length !== 1 || copiedText.matches[0].text !== "café") throw Error(JSON.stringify(copiedText));
const moved = await tools.move({path:copied,target:${JSON.stringify(moved)}});
const movedBytes = await tools.read({path:${JSON.stringify("raw:" + moved)},limit:3});
if (movedBytes?.bytes !== "77u/") throw Error("Move lost the UTF-8 BOM: " + JSON.stringify(movedBytes));
const movedText = await tools.search({path:moved,query:"café"});
if (movedText.matches.length !== 1 || movedText.matches[0].path !== ${JSON.stringify(moved)}) throw Error(JSON.stringify(movedText));
const written = await tools.write({path:moved,content:"changed café\\r\\n"});
text((await tools.read({path:written})).text);
const saved = await tools.read({path:${JSON.stringify(moved)}});
const restored = await tools.undo({file:saved,change:"last"});
const found = await tools.search({path:restored,query:"prior"});
if (found.matches.length !== 1 || found.matches[0].text !== "prior" || found.matches[0].path !== ${JSON.stringify(moved)}) throw Error(JSON.stringify(found));
text({copied,moved,restored,found});
const created = await tools.write({path:${JSON.stringify(created)},content:"created café"});
const cleared = await tools.delete({path:created});
const emptyFile = await tools.read({path:${JSON.stringify(created)}});
if (emptyFile?.text !== "") throw Error("Deleting a selection must leave the file present: " + JSON.stringify(emptyFile));
// Delete leaves no text to select: both the cleared selection and the removed file are null.
if (cleared !== null) throw Error("Deleted text granted a selection: " + cleared);
const removed = await tools.delete({path:${JSON.stringify(created)}});
if (removed !== null) throw Error("Restored absence must not grant text authority: " + removed);
text({removed});
`,
            },
          }),
        ]),
        assistantMessage([
          text("Restored present text retained native authority; absence has no target."),
        ]),
      ],
    }).run("Keep whole-file transfer bytes and restored source authority on their native owners.");
    for (const id of ["transfers"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    // Last text undo restores decoded text, not the BOM consumed by the text converter.
    expect((await backend.read(`${fixture.workspace}/moved.txt`)).bytes.toString("utf8")).toBe(
      original.slice(1),
    );
    await expect(backend.read(`${fixture.workspace}/copied.txt`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(backend.read(`${fixture.workspace}/created.txt`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(local, "utf8")).toBe(original);
    expect(getToolResultText(run, "transfers")).toContain("prior");
    expect(getToolResultText(run, "transfers")).toContain('"removed":null');
    // The refused Copy resolved to null and is listed with its reason.
    const refusals = codemodeFailures(getToolResultText(run, "transfers"));
    expect(refusals).toMatch(/^1 of \d+ IDE calls failed:\n- copy RESULT#[^\n]+\n/u);
    expect(refusals).toContain("no reusable text selection");
    expect(run.tuiRenderedOutput).toContain(root);
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 180000);
