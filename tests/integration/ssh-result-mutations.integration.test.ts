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

test("registered whole-file and paired text mutations preserve native identity and exact boundaries", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-result-mutations");
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
  const original = "alpha café omega\r\n";
  try {
    await writeFile(local, "LOCAL café\n");
    await backend.write(`${fixture.workspace}/note.txt`, Buffer.from(original), null);
    await backend.write(
      `${fixture.workspace}/destination.txt`,
      Buffer.from("REMOTE destination\r\n"),
      null,
    );
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
      testName: "ssh-result-mutations",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "select", "search", "write", "delete", "copy", "move", "undo", "codemode"],
      timeoutMs: 150000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "mutations",
            name: "codemode",
            arguments: {
              code: `
const file = ${JSON.stringify(`${root}/note.txt`)};
const whole = await tools.read({ path: file });
const partial = await tools.select({ path: whole, operation: { kind: "range", startLine: 1, startColumn: 6, endLine: 1, endColumn: 10 } });
let refused;
try { await tools.write({path:partial,content:"must not widen"}); } catch(error) { refused = String(error); }
if (!refused) throw Error("Partial write widened to whole-file authority");
text({refused});
const written = await tools.write({ path: whole, content: "after café\\r\\n" });
const saved = await tools.read({ path: written });
const restored = await tools.undo({ file: saved, change: "last" });
const fresh = await tools.read({ path: restored });
const span = await tools.select({ path: fresh, operation: { kind: "range", startLine: 1, startColumn: 6, endLine: 1, endColumn: 10 } });
const removed = await tools.delete({ path: span });
const remaining = await tools.read({ path: file });
const cleared = await tools.delete({ path: remaining });
text({ written, restored, removed, cleared });
const sourceRead = await tools.read({ path: ${JSON.stringify(local)} });
const source = await tools.select({ path: sourceRead, operation: { kind: "sliceText", from: 0, to: 5 } });
const destinationRead = await tools.read({ path: ${JSON.stringify(`${root}/destination.txt`)} });
const destination = await tools.select({ path: destinationRead, operation: { kind: "sliceText", from: 0, to: 6 } });
const copied = await tools.copy({ path: source, target: destination });
text(copied);
const copyScope = await tools.search({path:copied,query:"destination"});
if (!copyScope.includes("No matches found")) throw Error("Copy target widened: " + copyScope);
const destinationFresh = await tools.read({ path: ${JSON.stringify(`${root}/destination.txt`)} });
const point = await tools.select({ path: destinationFresh, operation: { kind: "sliceText", from: 5, to: 5 } });
const moved = await tools.move({ path: source, target: point });
text(moved);
const moveScope = await tools.search({path:moved,query:"LOCAL"});
const movedSpan = await tools.select({path:moveScope,operation:{kind:"sliceText",from:0}}); if (!movedSpan.includes("LOCAL")) throw Error(movedSpan);
const empty = await tools.delete({path:[]});
if (!empty.includes("No changes")) throw Error("Empty deletion is a no-op: " + empty);
`,
            },
          }),
        ]),
        assistantMessage([
          text("Selected publication and native source boundaries remained exact."),
        ]),
      ],
    }).run("Use registered source results without widening any source or destination.");
    expect(getToolExecution(run, "mutations").isError, getToolResultText(run, "mutations")).toBe(
      false,
    );
    expect((await backend.read(`${fixture.workspace}/note.txt`)).bytes.toString("utf8")).toBe("");
    expect(
      (await backend.read(`${fixture.workspace}/destination.txt`)).bytes.toString("utf8"),
    ).toBe("LOCALLOCAL destination\r\n");
    expect(await readFile(local, "utf8")).toBe(" café\n");
    expect(run.tuiRenderedOutput).toContain(root);
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 180000);
