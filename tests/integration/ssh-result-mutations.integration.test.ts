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
const refused = await tools.write({ path: partial, content: "must not widen" });
if (refused.status !== "error" || refused.data.effect !== "not-applied") throw Error("Partial write must fail: " + JSON.stringify(refused));
text({ refused });
const written = await tools.write({ path: whole, content: "after café\\r\\n" });
if (written.status !== "success" || written.data.effect === "not-applied") throw Error(JSON.stringify(written));
const saved = await tools.read({ path: file });
const restored = await tools.undo({ file: saved, change: "last" });
if (restored.status !== "success" || restored.data.effect === "not-applied") throw Error(JSON.stringify(restored));
const fresh = await tools.read({ path: file });
const span = await tools.select({ path: fresh, operation: { kind: "range", startLine: 1, startColumn: 6, endLine: 1, endColumn: 10 } });
const removed = await tools.delete({ path: span });
if (removed.status !== "success" || removed.data.effect === "not-applied") throw Error(JSON.stringify(removed));
const remaining = await tools.read({ path: file });
const cleared = await tools.delete({ path: remaining });
if (cleared.status !== "success" || cleared.data.effect === "not-applied") throw Error(JSON.stringify(cleared));
text({ written, restored, removed, cleared });
if (typeof written.data.target !== "string" || typeof restored.data.target !== "string") throw Error("Whole-file writes and undo need verified resulting targets");
if (removed.data.target !== undefined || cleared.data.target !== undefined) throw Error("Delete must not grant an editable target");
const sourceRead = await tools.read({ path: ${JSON.stringify(local)} });
const source = await tools.select({ path: sourceRead, operation: { kind: "sliceText", from: 0, to: 5 } });
const destinationRead = await tools.read({ path: ${JSON.stringify(`${root}/destination.txt`)} });
const destination = await tools.select({ path: destinationRead, operation: { kind: "sliceText", from: 0, to: 6 } });
const copied = await tools.copy({ path: source, target: destination });
if (copied.status !== "success" || copied.data.effect === "not-applied") throw Error("Selected copy must use exact ordered ranges: " + JSON.stringify(copied));
text(copied);
const copyScope = await tools.search({path:copied,query:"destination"});
if(copyScope.status !== "success" || copyScope.data.matches.length !== 0) throw Error("Copy target widened to unchanged destination: " + JSON.stringify(copyScope));
const destinationFresh = await tools.read({ path: ${JSON.stringify(`${root}/destination.txt`)} });
const point = await tools.select({ path: destinationFresh, operation: { kind: "sliceText", from: 5, to: 5 } });
const moved = await tools.move({ path: source, target: point });
if (moved.status !== "success" || moved.data.effect === "not-applied") throw Error(JSON.stringify(moved));
text(moved);
const moveScope = await tools.search({path:moved,query:"LOCAL"});
if(moveScope.status !== "success" || moveScope.data.matches.length !== 1 || moveScope.data.matches[0].range.startColumn !== 5) throw Error("Move must select only inserted destination text: " + JSON.stringify(moveScope));
const empty = await tools.delete({path:[]});
if(empty.status !== "success" || empty.data.effect !== "not-applied" || empty.data.target !== undefined) throw Error("Empty deletion is a no-op: " + JSON.stringify(empty));
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
