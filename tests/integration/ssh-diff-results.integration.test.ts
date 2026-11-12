import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("remote Diff keeps full snapshots, bounded output and session-owned temporary results", async () => {
  const base = path.resolve(".tmp/ssh-diff-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const leftFixture = await startSshFixture();
  let rightFixture: Awaited<ReturnType<typeof startSshFixture>> | undefined;
  try {
    rightFixture = await startSshFixture();
    const fixtures = [leftFixture, rightFixture];
    const backends = fixtures.map(
      (fixture, index) =>
        new SshBackend({
          id: index === 0 ? "left" : "right",
          host: "fixture",
          workspace: fixture.workspace,
          configFile: fixture.config,
        }),
    );
    const [leftBackend, rightBackend] = backends;
    if (!leftBackend || !rightBackend) throw Error("Missing fixture backend");
    const left = `ssh://left${leftFixture.workspace}/note.txt`;
    const right = `ssh://right${rightFixture.workspace}/note.txt`;
    const before = Array.from({ length: 2205 }, (_, i) => `left café row ${i}\r\n`).join("");
    const after = Array.from({ length: 2205 }, (_, i) => `right café row ${i}\r\n`).join("");
    const local = path.join(cwd, "note.txt");
    await writeFile(local, before);
    await Promise.all(
      backends.map((backend, i) =>
        backend.write(
          path.join(backend.target.workspace, "note.txt"),
          Buffer.from(i === 0 ? before : after),
          null,
        ),
      ),
    );
    const config = path.join(cwd, ".pi/pi-agent-ide");
    await mkdir(config, { recursive: true });
    await writeFile(
      path.join(config, "ssh.json"),
      JSON.stringify({ targets: backends.map((b) => b.target) }),
    );
    await writeFile(
      path.join(config, "extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: [
          "ide.ast",
          "ide.lsp",
          "ide.lint",
          "ide.formatter",
          "ide.debugger",
          "ide.diagnostics",
          "ide.terminal",
        ],
      }),
    );
    const options = {
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "diff", "write", "replace", "codemode"],
      timeoutMs: 90000,
    };
    const run = await new PiIntegrationTest({
      ...options,
      testName: "ssh-diff-results",
      conversation: [
        assistantMessage([
          toolCall({
            id: "ordinary",
            name: "diff",
            arguments: {
              before: { path: left, offset: 2205, limit: 1, views: ["anchors"] },
              after: { path: right, offset: 2205, limit: 1, views: ["anchors"] },
            },
          }),
        ]),
        assistantMessage([
          toolCall({ id: "full", name: "diff", arguments: { before: left, after: right } }),
        ]),
        assistantMessage([
          toolCall({
            id: "snapshots",
            name: "codemode",
            arguments: {
              code: `
const left = ${JSON.stringify(left)}, right = ${JSON.stringify(right)};
function check(value, message) { if (!value) throw Error(message); }
const mixed = await tools.diff({before:${JSON.stringify(local)},after:left});
check(mixed === "","Equal local/remote bytes changed meaning");
const lines=(await tools.diff({before:left,after:right})).split("\\n");
check(lines[0]==="--- "+left && lines[1]==="+++ "+right,"Comparison lost owner identities");
const rows=lines.slice(3).map((row)=>row.replace(/\\r$/,""));
check(rows.length===4410 && rows.every((row,index)=>row===(index<2205?"-left café row "+index:"+right café row "+(index-2205))),"Script diff is not complete");
text(await tools.write({path:right,content:"new remote snapshot\\r\\n"}));
const current=await tools.read({path:right});
check(current.includes("new remote snapshot"),"Owner file was not changed");
text({before:left,after:right,rows:rows.length});
`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "final-window",
            name: "diff",
            arguments: {
              before: { path: left, offset: 1, limit: 1 },
              after: { path: right, offset: 1, limit: 1 },
            },
          }),
        ]),
        assistantMessage([text("Full source comparison and temporary result verified.")]),
      ],
    }).run(
      "Compare the two configured SSH sources without losing their identities or saved full output.",
    );
    for (const id of ["ordinary", "full", "snapshots", "final-window"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(codemodeFailures(getToolResultText(run, "snapshots"))).toBe("");
    expect(getToolResultText(run, "ordinary")).toContain(left);
    expect(getToolResultText(run, "ordinary")).toContain(right);
    expect(getToolResultText(run, "ordinary")).toContain("row 2204");
    // A direct call shows a bounded diff and saves the full one as a session-owned temporary result.
    const full = getToolResultText(run, "full");
    expect(full).toContain("Diff output is truncated");
    const reference = full.match(/temp:[a-zA-Z0-9-]+/u)?.[0];
    if (!reference) throw Error("Missing actual temporary result receipt");
    const next = await new PiIntegrationTest({
      ...options,
      testName: "ssh-diff-expired-result",
      conversation: [
        assistantMessage([
          toolCall({ id: "expired", name: "read", arguments: { path: reference } }),
        ]),
        assistantMessage([text("The prior session's temporary result is unavailable.")]),
      ],
    }).run(
      "Reject a temporary result from the completed prior session without reading another source.",
    );
    expect(getToolExecution(next, "expired").isError).toBe(true);
    expect(getToolResultText(next, "expired")).not.toContain("right café row");
    expect(run.tuiRenderedOutput).toContain(left);
    expect(run.tuiRenderedOutput).toContain(right);
    expect(await readFile(local, "utf8")).toBe(before);
    expect(
      (await leftBackend.read(`${leftFixture.workspace}/note.txt`)).bytes.toString("utf8"),
    ).toBe(before);
    expect(
      (await rightBackend.read(`${rightFixture.workspace}/note.txt`)).bytes.toString("utf8"),
    ).toBe("new remote snapshot\r\n");
  } finally {
    await Promise.all([leftFixture.stop(), rightFixture?.stop()]);
    await rm(cwd, { recursive: true, force: true });
  }
  for (const fixture of [leftFixture, rightFixture]) {
    await expect(access(fixture.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`/proc/${fixture.serverPid}`)).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 150000);
