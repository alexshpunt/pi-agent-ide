import { execFile } from "node:child_process";
import {
  access,
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { remoteLocation } from "#src/backend/identity.js";
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
import { startSshPidNamespaceFixture } from "#integration/support/ssh-pid-namespace-fixture.js";

const execute = promisify(execFile);
const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("identical absolute file paths stay target-owned across private mount namespaces", async () => {
  const base = path.resolve(".tmp/ssh-file-identity-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  await mkdir("/tmp/.tmp", { recursive: true });
  const shared = await mkdtemp("/tmp/.tmp/pi-ide-file-identities-");
  await chmod(shared, 0o755);
  const common = path.join(shared, "same-path");
  await mkdir(common, { mode: 0o755 });
  const name = "note café #?%.txt";
  await writeFile(path.join(common, name), "CONTROLLER\n");
  const left = await startSshPidNamespaceFixture();
  let right: Awaited<ReturnType<typeof startSshPidNamespaceFixture>> | undefined;
  try {
    right = await startSshPidNamespaceFixture();
    const fixtures = [left, right];
    const ids = ["left", "right"] as const;
    for (const [index, fixture] of fixtures.entries()) {
      const mountNamespace = await readlink(`/proc/${fixture.controllerPid}/ns/mnt`);
      expect(mountNamespace).not.toBe(await readlink("/proc/self/ns/mnt"));
      await mkdir(path.join(fixture.workspace, "nested"));
      await writeFile(path.join(fixture.workspace, name), `${ids[index]} café\r\nlast`);
      const owner = await stat(fixture.workspace);
      await chown(path.join(fixture.workspace, name), owner.uid, owner.gid);
      await writeFile(
        path.join(fixture.workspace, "invalid.txt"),
        Buffer.from([0x61, 0x80, 0xff, 0x0a]),
      );
      await symlink(path.join(common, name), path.join(fixture.workspace, "nested/link.txt"));
      // Both bindings are private to the exact owned namespace; the controller entry stays intact.
      await execute("nsenter", [
        "--target",
        String(fixture.controllerPid),
        "--mount",
        "--",
        "mount",
        "--bind",
        fixture.workspace,
        common,
      ]);
    }
    await writeFile(path.join(cwd, "invalid.txt"), Buffer.from([0x61, 0x80, 0xff, 0x0a]));
    await writeFile(path.join(cwd, "comparison.txt"), "left café\r\nlast");
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({
        targets: fixtures.map((fixture, index) => ({
          id: ids[index],
          host: "fixture",
          workspace: path.join(common, "nested"),
          configFile: fixture.config,
        })),
      }),
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
          "ide.terminal",
        ],
      }),
    );
    const sources = ids.map((id) => remoteLocation(id, path.join(common, name)).source);
    const linkSource = remoteLocation("left", path.join(common, "nested/link.txt")).source;
    const invalidSource = remoteLocation("left", path.join(common, "invalid.txt")).source;
    const run = await new PiIntegrationTest({
      testName: "ssh-file-identities",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "replace", "codemode"],
      timeoutMs: 60000,
      conversation: [
        ...sources.map((source, index) =>
          assistantMessage([
            toolCall({
              id: index === 0 ? "left" : "right",
              name: "read",
              arguments: { path: source, views: ["anchors"] },
            }),
          ]),
        ),
        assistantMessage([
          toolCall({
            id: "link",
            name: "read",
            arguments: { path: linkSource, views: ["anchors"] },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "inherited",
            name: "replace",
            arguments: { start: "left café", text: "LEFT VERIFIED" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "native",
            name: "codemode",
            arguments: {
              code: `
const sources=${JSON.stringify(sources)};

for(let i=0;i<sources.length;i++) {
 const result=await tools.read({path:sources[i],views:["anchors"]});
 if(!result.includes(sources[i]) || !result.includes(["LEFT VERIFIED","right café"][i])) throw Error("Target identity crossed a namespace: "+result);
 text(result);
}
async function inspect(request) {
 try { return {text:await tools.read(request)}; } catch(error) { return {error:String(error)}; }
}
const local=await inspect({path:"invalid.txt"});
const remote=await inspect({path:${JSON.stringify(invalidSource)}});
if(("error" in local)!==("error" in remote)) throw Error("Invalid UTF-8 changed Read semantics");
if("text" in local && "text" in remote) {
 const body=s=>s.replace(/^<system-result[^\\n]*>\\n/,"").trim();
 if(body(local.text)!==body(remote.text)) throw Error("Invalid UTF-8 text differs");
}
const before=await tools.read({path:"comparison.txt",offset:2,limit:1});
const after=await tools.read({path:sources[1],offset:2,limit:1});
if(!before.includes("last") || !after.includes("last") || after.includes("right café")) throw Error("No-final-LF window differs");
text({local,remote,lastLine:after});
`,
            },
          }),
        ]),
        assistantMessage([
          text(
            "Identical paths resolve to distinct native files; inherited edits preserve the other target and controller.",
          ),
        ]),
      ],
    }).run(
      "Read both explicit target identities, follow the owned symlink and preserve source ownership when the edit omits its path.",
    );
    for (const id of ["left", "right", "link", "inherited", "native"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(getToolResultText(run, "left")).toContain("left café");
    expect(getToolResultText(run, "right")).toContain("right café");
    expect(getToolResultText(run, "native")).toContain(sources[0]);
    expect(getToolResultText(run, "native")).toContain(sources[1]);
    expect(await readFile(path.join(left.workspace, name), "utf8")).toBe("LEFT VERIFIED\r\nlast");
    expect(await readFile(path.join(right.workspace, name), "utf8")).toBe("right café\r\nlast");
    expect(await readFile(path.join(common, name), "utf8")).toBe("CONTROLLER\n");
    expect(run.tuiRenderedOutput).toContain(sources[0]);
    expect(run.tuiRenderedOutput).toContain(sources[1]);
  } finally {
    await left.stop();
    await right?.stop();
    await rm(cwd, { recursive: true, force: true });
    await rm(shared, { recursive: true, force: true });
  }
  for (const fixture of [left, right]) {
    await expect(access(fixture.root)).rejects.toMatchObject({ code: "ENOENT" });
    for (const pid of [fixture.serverPid, fixture.controllerPid, fixture.controllerSshdPid])
      await expect(access(`/proc/${pid}`)).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 90000);
