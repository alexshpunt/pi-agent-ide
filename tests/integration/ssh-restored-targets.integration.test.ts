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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackend } from "#src/backend/ssh.js";

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
const copied = await tools.copy({path:source,target:${JSON.stringify(copied)}});
const copiedText = await tools.search({path:copied,query:"café"});
if (!copiedText.includes("café")) throw Error(copiedText);
const moved = await tools.move({path:copied,target:${JSON.stringify(moved)}});
const movedText = await tools.search({path:moved,query:"café"});
if (!movedText.includes(${JSON.stringify(moved)})) throw Error(movedText);
const written = await tools.write({path:moved,content:"changed café\\r\\n"});
text(await tools.read({path:written}));
const saved = await tools.read({path:${JSON.stringify(moved)}});
const restored = await tools.undo({file:saved,change:"last"});
const found = await tools.search({path:restored,query:"prior"});
if (!found.includes("prior") || !found.includes(${JSON.stringify(moved)})) throw Error(found);
text({copied,moved,restored,found});
const created = await tools.write({path:${JSON.stringify(created)},content:"created café"});
const removed = await tools.delete({path:created});
let refusal;
try { await tools.read({path:removed}); } catch(error) { refusal = String(error); }
if (!refusal) throw Error("Restored absence must not grant text authority");
text({removed,refusal});
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
    expect(getToolResultText(run, "transfers")).toContain("prior");
    expect(getToolResultText(run, "transfers")).toContain("refusal");
    expect(run.tuiRenderedOutput).toContain(root);
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 180000);
