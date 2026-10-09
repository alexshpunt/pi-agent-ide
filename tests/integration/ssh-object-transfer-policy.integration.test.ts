import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import {
  withTempWorkspace,
  enableNativeCodemode,
} from "#integration/support/pi-runtime/fixtures.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackend } from "#src/backend/ssh.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test.each(["direct-yes", "native-yes", "native-no", "native-race"] as const)(
  "real SSH Move keeps both owner policies through %s",
  async (scenario) => {
    const fixtures = [await startSshFixture(), await startSshFixture()];
    const owners = fixtures.map(
      (fixture, index) =>
        new SshBackend({
          id: index === 0 ? "left" : "right",
          host: "fixture",
          workspace: fixture.workspace,
          configFile: fixture.config,
        }),
    );
    const sourceOwner = owners[0];
    const targetOwner = owners[1];
    if (!sourceOwner || !targetOwner) throw Error("Missing fixture owner");
    const decision = scenario.endsWith("yes") ? "yes" : scenario.endsWith("no") ? "no" : "race";
    const names = [`source-tracked-${decision}`, `target-tracked-${decision}`];
    const source = `ssh://left${sourceOwner.target.workspace}/${names[0]}`;
    const target = `ssh://right${targetOwner.target.workspace}/${names[1]}`;
    try {
      for (const [index, owner] of owners.entries()) {
        const setup = await owner.execute(
          "python3",
          [
            "-c",
            String.raw`
import pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1]);subprocess.run(['git','init','-q',str(p)],check=True)
d=p/sys.argv[2];d.mkdir();(d/'data').write_text(sys.argv[3])
subprocess.run(['git','-C',str(p),'add',sys.argv[2]],check=True)
`,
            owner.target.workspace,
            String(names[index]),
            index === 0 ? "source" : "target",
          ],
          owner.target.workspace,
        );
        expect(setup.exitCode).toBe(0);
      }
      await withTempWorkspace(async (cwd) => {
        await enableNativeCodemode(cwd);
        await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
        await writeFile(
          path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
          JSON.stringify({ targets: owners.map((owner) => owner.target) }),
        );
        await writeFile(
          path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
          JSON.stringify({
            noAnimations: true,
            disabled: [
              "ide.lsp",
              "ide.lint",
              "ide.diagnostics",
              "ide.changes",
              "ide.debugger",
              "ide.terminal",
              "ide.vision",
              "ide.formatting",
            ],
          }),
        );
        const args = { path: source, target };
        const expectedError =
          decision === "yes"
            ? undefined
            : decision === "no"
              ? "DELETE_NOT_APPROVED"
              : "DELETE_TARGET_CHANGED";
        const call = scenario.startsWith("direct")
          ? toolCall({ id: "transfer", name: "move", arguments: args })
          : toolCall({
              id: "transfer",
              name: "codemode",
              arguments: {
                code:
                  expectedError === undefined
                    ? `const result=await tools.move(${JSON.stringify(args)});text(result);let refused=false;try{await tools.search({path:result,query:'data'});}catch(error){if(!String(error).includes('no reusable text selection'))throw error;refused=true;}if(!refused)throw Error('Object receipt granted text authority');`
                    : `let refused=false;try{await tools.move(${JSON.stringify(args)});}catch(error){if(!String(error).includes(${JSON.stringify(expectedError)}))throw error;text(String(error));refused=true;}if(!refused)throw Error('Removal bypassed owner policy');`,
              },
            });
        const run = await new PiIntegrationTest({
          testName: `ssh-object-transfer-policy-${scenario}`,
          cwd,
          rawMode: false,
          isolateUserResources: true,
          artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
          extensions: [
            "builtin:codemode",
            path.resolve("src/pi-agent-ide.ts"),
            path.resolve("tests/integration/support/ssh-transfer-approval-probe.ts"),
          ],
          tools: ["move", "search", "codemode"],
          timeoutMs: 90_000,
          conversation: [
            assistantMessage([call]),
            assistantMessage([text("Checked both native owner policies.")]),
          ],
        }).run("Move only after both host removal policies approve unchanged native objects.");
        expect(getToolExecution(run, "transfer").isError, getToolResultText(run, "transfer")).toBe(
          false,
        );
        if (decision === "yes") {
          await expect(
            sourceOwner.lstat(`${sourceOwner.target.workspace}/${names[0]}`),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            (
              await targetOwner.read(`${targetOwner.target.workspace}/${names[1]}/data`)
            ).bytes.toString(),
          ).toBe("source");
          expect(getToolResultText(run, "transfer")).toContain("move: applied");
          expect(getToolResultText(run, "transfer")).not.toContain("Post-processing failed");
          expect(run.tuiRenderedOutput).toContain("Applied");
        } else {
          expect(
            (
              await sourceOwner.read(`${sourceOwner.target.workspace}/${names[0]}/data`)
            ).bytes.toString(),
          ).toBe(decision === "race" ? "replacement" : "source");
          expect(
            (
              await targetOwner.read(`${targetOwner.target.workspace}/${names[1]}/data`)
            ).bytes.toString(),
          ).toBe("target");
          expect(getToolResultText(run, "transfer")).toContain(expectedError);
        }
        const hooks = (await readFile(path.join(cwd, "transfer-hooks.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { path: string; cwd: string });
        expect(hooks[0]).toMatchObject({
          path: source,
          cwd: `ssh://left${sourceOwner.target.workspace}`,
        });
        if (decision !== "no")
          expect(hooks[1]).toMatchObject({
            path: target,
            cwd: `ssh://right${targetOwner.target.workspace}`,
          });
        const dialogs = (await readFile(path.join(cwd, "transfer-dialogs.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { message: string; approved: boolean });
        expect(dialogs.map((item) => item.approved)).toEqual(
          decision === "no" ? [false] : [true, true],
        );
        expect(dialogs[0]?.message).toContain(source);
        if (decision !== "no") expect(dialogs[1]?.message).toContain(target);
      });
    } finally {
      await Promise.all(fixtures.map((fixture) => fixture.stop()));
    }
  },
  120_000,
);
