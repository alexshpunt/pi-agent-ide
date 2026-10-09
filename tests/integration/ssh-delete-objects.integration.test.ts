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
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import {
  withTempWorkspace,
  enableNativeCodemode,
} from "#integration/support/pi-runtime/fixtures.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackend } from "#src/backend/ssh.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test.each(["objects", "approvals", "race"] as const)(
  "SSH Delete preserves target-owned %s policy",
  async (scenario) => {
    const fixture = await startSshFixture();
    const backend = new SshBackend({
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    });
    const root = `ssh://fixture${fixture.workspace}`;
    try {
      const setup = await backend.execute(
        "python3",
        [
          "-c",
          String.raw`
import os,pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1]); subprocess.run(['git','init','-q',str(p)],check=True)
for name in ['untracked','script-untracked','locked-delete','direct-tracked-no','direct-tracked-yes','script-tracked-no','script-tracked-yes','tracked-race']:
 d=p/name; d.mkdir(); (d/'data').write_text('keep')
(p/'sentinel').write_text('untouched')
(p/'link').symlink_to('sentinel'); (p/'broken').symlink_to('missing')
(p/'untracked'/'link').symlink_to(p/'sentinel')
subprocess.run(['git','-C',str(p),'add','direct-tracked-no','direct-tracked-yes','script-tracked-no','script-tracked-yes','tracked-race'],check=True)
`,
          fixture.workspace,
        ],
        fixture.workspace,
      );
      expect(setup.exitCode).toBe(0);
      await withTempWorkspace(async (cwd) => {
        await enableNativeCodemode(cwd);
        await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
        await writeFile(
          path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
          JSON.stringify({ targets: [backend.target] }),
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
            ],
          }),
        );
        const direct = (id: string, name: string) =>
          toolCall({ id, name: "delete", arguments: { path: `${root}/${name}` } });
        const calls = [
          direct("untracked", "untracked"),
          direct("link", "link"),
          direct("broken", "broken"),
          direct("locked", "locked-delete"),
          direct("protected", ".git/config"),
          direct("direct-no", "direct-tracked-no"),
          direct("direct-yes", "direct-tracked-yes"),
          direct("race", "tracked-race"),
          toolCall({
            id: "native",
            name: "codemode",
            arguments: {
              code: `
let denied=false; try { await tools.delete({path:${JSON.stringify(`${root}/script-tracked-no`)}}); } catch (error) { if(!String(error).includes("DELETE_NOT_APPROVED")) throw error; denied=true; }
if(!denied) throw Error("Host refusal must block SSH removal");
text(await tools.delete({path:${JSON.stringify(`${root}/script-tracked-yes`)}}));
text(await tools.delete({path:${JSON.stringify(`${root}/script-untracked`)}}));
`,
            },
          }),
        ];
        const selectedCalls =
          scenario === "objects"
            ? calls.slice(0, 5)
            : scenario === "approvals"
              ? [calls[5], calls[6], calls[8]]
              : [calls[7]];
        const selected = selectedCalls.filter(
          (call): call is NonNullable<typeof call> => call !== undefined,
        );
        const ids = new Set(selected.map((call) => call.id));
        const run = await new PiIntegrationTest({
          testName: `ssh-delete-protected-objects-${scenario}`,
          cwd,
          rawMode: false,
          isolateUserResources: true,
          artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
          extensions: [
            "builtin:codemode",
            path.resolve("src/pi-agent-ide.ts"),
            path.resolve("tests/integration/support/ssh-delete-policy-probe.ts"),
          ],
          tools: ["delete", "codemode"],
          timeoutMs: 90_000,
          conversation: [
            ...selected.map((call) => assistantMessage([call])),
            assistantMessage([text("Checked target-owned deletion policy.")]),
          ],
        }).run("Delete only the target objects allowed by both hooks and host decisions.");
        for (const id of ["untracked", "link", "broken", "direct-yes", "native"]) {
          if (ids.has(id))
            expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
        }
        for (const [id, code] of [
          ["locked", "DELETE_HOOK_REJECTED"],
          ["protected", "DELETE_PROTECTED_TARGET"],
          ["direct-no", "DELETE_NOT_APPROVED"],
          ["race", "DELETE_TARGET_CHANGED"],
        ] as const) {
          if (!ids.has(id)) continue;
          expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(true);
          expect(getToolResultText(run, id)).toContain(code);
          expect(getToolResultText(run, id)).toContain("not-applied");
        }
        for (const name of scenario === "objects"
          ? ["untracked", "link", "broken"]
          : scenario === "approvals"
            ? ["script-untracked", "direct-tracked-yes", "script-tracked-yes"]
            : [])
          await expect(backend.lstat(`${fixture.workspace}/${name}`)).rejects.toMatchObject({
            code: "ENOENT",
          });
        for (const name of ["locked-delete", "direct-tracked-no", "script-tracked-no"])
          expect((await backend.read(`${fixture.workspace}/${name}/data`)).bytes.toString()).toBe(
            "keep",
          );
        if (scenario === "race") {
          expect(
            (await backend.read(`${fixture.workspace}/tracked-race/data`)).bytes.toString(),
          ).toBe("replacement");
          expect(
            (
              await backend.read(`${fixture.workspace}/tracked-race-previous/data`)
            ).bytes.toString(),
          ).toBe("keep");
        }
        expect((await backend.read(`${fixture.workspace}/sentinel`)).bytes.toString()).toBe(
          "untouched",
        );
        const decisions = (
          await readFile(path.join(cwd, "dialog-decisions.jsonl"), "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return "";
              throw error;
            },
          )
        )
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { message: string; approved: boolean });
        expect(decisions.map(({ approved }) => approved)).toEqual(
          scenario === "objects"
            ? []
            : scenario === "approvals"
              ? [false, true, false, true]
              : [true],
        );
        expect(decisions.every(({ message }) => message.startsWith(root + "/"))).toBe(true);
        const hooks = (await readFile(path.join(cwd, "delete-hooks.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                path: string;
                resolvedPath: string;
                cwd: string;
                kind: string;
                recursive: boolean;
              },
          );
        expect(
          hooks.every(
            (event) =>
              event.path.startsWith(root + "/") &&
              event.resolvedPath.startsWith(root + "/") &&
              event.cwd === root,
          ),
        ).toBe(true);
        if (scenario === "objects")
          expect(hooks.some((event) => event.kind === "symlink" && !event.recursive)).toBe(true);
        expect(hooks.some((event) => event.kind === "directory" && event.recursive)).toBe(true);
      });
    } finally {
      await fixture.stop();
    }
  },
  120_000,
);
