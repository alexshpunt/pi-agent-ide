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
      tools: ["read", "search", "write", "delete", "copy", "move", "undo", "codemode"],
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
const partial = await tools.search({ path: whole, query: "café" });
if (partial.matches.length !== 1) throw Error("Missing partial selection: " + JSON.stringify(partial));
// A refused IDE call resolves to null; the Codemode result lists its reason.
const refused = (await tools.write({path:partial,content:"must not widen"})) === null;
if (!refused) throw Error("Partial write widened to whole-file authority");
text({refused});
const written = await tools.write({ path: whole, content: "after café\\r\\n" });
const saved = await tools.read({ path: written });
const restored = await tools.undo({ file: saved, change: "last" });
const fresh = await tools.read({ path: restored });
const span = await tools.search({ path: fresh, query: "café" });
const removed = await tools.delete({ path: span });
const remaining = await tools.read({ path: file });
const cleared = await tools.delete({ path: remaining });
text({ written, restored, removed, cleared });
const sourceRead = await tools.read({ path: ${JSON.stringify(local)} });
const source = await tools.search({ path: sourceRead, query: "LOCAL" });
const destinationRead = await tools.read({ path: ${JSON.stringify(`${root}/destination.txt`)} });
const destination = await tools.search({ path: destinationRead, query: "REMOTE" });
const copied = await tools.copy({ path: source, target: destination });
text(copied);
const copyScope = await tools.search({path:copied,query:"destination"});
if (copyScope.matches.length !== 0 || copyScope.complete !== true) throw Error("Copy target widened: " + JSON.stringify(copyScope));
const destinationFresh = await tools.read({ path: ${JSON.stringify(`${root}/destination.txt`)} });
const point = await tools.search({ path: destinationFresh, query: "regex:(?<=^LOCAL)" });
const moved = await tools.move({ path: source, target: point });
text(moved);
const moveScope = await tools.search({path:moved,query:"LOCAL"});
if (moveScope.matches.length !== 1) throw Error(JSON.stringify(moveScope));
const empty = await tools.delete({path:[]});
// An empty deletion is a successful no-op; Delete resolves to null and nothing fails.
if (empty !== null) throw Error("Empty deletion selected text: " + empty);
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
    expect(codemodeFailures(getToolResultText(run, "mutations"))).toMatch(
      /^1 of \d+ IDE calls failed:\n- write RESULT#\S+\n/u,
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
