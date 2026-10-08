import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { startSshCarrierFixture } from "#integration/support/ssh-carrier-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
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

const restore = forceStandaloneIntegrationFile();
afterAll(restore);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("ordinary Pi reports a genuinely lost SSH terminal without inventing exit zero", async () => {
  const fixture = await startSshCarrierFixture();
  const base = path.resolve(".tmp/ssh-carrier-tool-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const scope = `ssh://fixture${fixture.workspace}`;
  const marker = `${fixture.workspace}/command.pid`;
  const release = `${fixture.workspace}/release`;
  const cutGate = path.join(cwd, "cut-gate");
  const cutDone = path.join(cwd, "cut-done");
  const controller = new AbortController();
  let cut: Promise<{ pid: number; nativeGoneBeforePiExit: boolean; dropped: number }> | undefined;
  try {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [fixture.target] }),
    );
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
          "ide.changes",
          "ide.diagnostics",
          "ide.debugger",
          "ide.vision",
        ],
      }),
    );
    const script = await readFile("tests/integration/fixtures/configured-owner-wait.py", "utf8");
    const command = [
      "exec python3 -c",
      quote(script),
      quote(`${fixture.workspace}/note.py`),
      quote(marker),
      quote(release),
    ].join(" ");
    cut = (async () => {
      const deadline = Date.now() + 15000;
      for (;;) {
        controller.signal.throwIfAborted();
        try {
          await access(cutGate);
          break;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        }
        if (Date.now() >= deadline) throw new Error("Pi did not request its owned carrier cut");
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      const pid = Number((await fixture.direct.read(marker)).bytes.toString("utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("No exact native Pi command PID");
      const dropped = await fixture.dropConnections();
      const gone = await fixture.direct.execute(
        "python3",
        [
          "-c",
          "import pathlib,sys,time; p=pathlib.Path('/proc')/sys.argv[1]; end=time.monotonic()+3\nwhile p.exists() and time.monotonic()<end: time.sleep(.02)\nprint('alive' if p.exists() else 'gone')",
          String(pid),
        ],
        fixture.workspace,
      );
      if (gone.stdout.toString("utf8") !== "gone\n")
        throw new Error("Native Pi command survived the carrier cut");
      const registry = new SshBackendRegistry([fixture.direct.target]);
      await expect(readSshProcessMetadata(registry, scope, pid)).rejects.toMatchObject({
        code: "ENOENT",
      });
      // This gate is written before the next tool finishes, while Pi is still running.
      await writeFile(cutDone, "cut and reconciled\n");
      return { pid, nativeGoneBeforePiExit: true, dropped };
    })();
    void cut.catch(() => {});
    const wait =
      "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); end=time.monotonic()+5\nwhile not p.exists() and time.monotonic()<end: time.sleep(.02)\nprint(p.read_text() if p.exists() else 'missing')";
    const run = await new PiIntegrationTest({
      testName: "ssh-real-carrier-terminal",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["bash", "read", "write", "delete", "codemode"],
      timeoutMs: 60000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "start-owned",
            name: "codemode",
            arguments: {
              code: `const child=await tools.bash({command:${JSON.stringify(command)},cwd:${JSON.stringify(scope)},background:true}); if(!child.remote) throw new Error("Missing native owner"); store("carrierChild",child); text(child); text(await tools.write({path:${JSON.stringify(cutGate)},content:"cut only my fixture connection\\n"}));`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "observe-loss",
            name: "codemode",
            arguments: {
              code: `const child=load("carrierChild"); const checked=await tools.bash({command:${JSON.stringify(`python3 -c ${quote(wait)} ${quote(cutDone)}`)},cwd:${JSON.stringify(cwd)}}); try { text(checked); text(await tools.read({path:child.source})); } finally { text(await tools.delete({path:checked.source})); text(await tools.delete({path:child.source})); }`,
            },
          }),
        ]),
        assistantMessage([text("Owned carrier loss observed without claiming exit zero.")]),
      ],
    }).run(
      "Use the configured SSH terminal; report actual carrier loss and retain its unknown outcome.",
    );
    const proof = await cut;
    expect(proof.dropped).toBe(1);
    expect(proof.nativeGoneBeforePiExit).toBe(true);
    expect(getToolExecution(run, "start-owned").isError).toBe(false);
    expect(getToolExecution(run, "observe-loss").isError).toBe(false);
    const output = getToolResultText(run, "observe-loss");
    expect(output).toContain("lost");
    expect(output).toContain(scope);
    expect(output).toContain("TRANSPORT_FAILED");
    expect(run.tuiRenderedOutput).toContain("lost");
    expect(run.tuiRenderedOutput).toContain(scope);
    expect((await fixture.direct.read(`${fixture.workspace}/note.py`)).bytes.toString("utf8")).toBe(
      'label = "café after command"\n',
    );
  } finally {
    controller.abort(new Error("Finish only this owned carrier fixture"));
    await cut?.catch(() => {});
    await fixture.direct.write(release, Buffer.from("release\n"), null);
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);
