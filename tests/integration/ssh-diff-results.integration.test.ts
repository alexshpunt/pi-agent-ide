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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackend } from "#src/backend/ssh.js";

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
          "ide.vision",
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
          toolCall({
            id: "snapshots",
            name: "codemode",
            arguments: {
              code: `
const left = ${JSON.stringify(left)}, right = ${JSON.stringify(right)};
function check(value, message) { if (!value) throw Error(message); }
const mixed = await tools.diff({before:${JSON.stringify(local)},after:left});

check(mixed.includes("No differences"),"Equal local/remote bytes changed meaning");
const result=await tools.diff({before:left,after:right});
check(result.includes(left) && result.includes(right),"Comparison lost owner identities");
const source=/temp:[a-zA-Z0-9-]+/.exec(result)?.[0];
check(source && result.includes("truncated"),"Full comparison lost continuation");
const tail=await tools.read({path:source,offset:-3,limit:3});
check(tail.includes("right café row 2204"),"Full diff lost final source row");
let rejected;
try { await tools.replace({path:result,text:"BAD"}); } catch(error) { rejected=String(error); }
check(rejected,"Diff gained edit authority");
text(await tools.write({path:right,content:"new remote snapshot\\r\\n"}));
store("diff-result",{source,tail:tail.replace(/^<system-result[^\\n]*>\\n/,"")});
text({temporary:source,before:left,after:right});
`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "retained",
            name: "codemode",
            arguments: {
              code: `
const saved = load("diff-result");
if (!saved) throw Error("Missing exact saved result");
const repeated = await tools.read({path:saved.source,offset:-3,limit:3});

if(repeated.replace(/^<system-result[^\\n]*>\\n/,"")!==saved.tail) throw Error("Temporary snapshot followed file change");
const current=await tools.read({path:${JSON.stringify(right)}});
if(!current.includes("new remote snapshot")) throw Error("Owner file was not changed");
text({retained:saved.source,readonly:true,current});
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
        assistantMessage([text("Full source comparison and frozen temporary result verified.")]),
      ],
    }).run(
      "Compare the two configured SSH sources without losing their identities or saved full output.",
    );
    for (const id of ["ordinary", "snapshots", "retained", "final-window"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(getToolResultText(run, "ordinary")).toContain(left);
    expect(getToolResultText(run, "ordinary")).toContain(right);
    expect(getToolResultText(run, "ordinary")).toContain("row 2204");
    const reference = getToolResultText(run, "snapshots").match(/temp:[a-zA-Z0-9-]+/u)?.[0];
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
