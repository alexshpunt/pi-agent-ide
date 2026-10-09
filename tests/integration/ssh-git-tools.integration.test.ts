import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createOwnedGitExecutor } from "#src/backend/git-registration.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { ChangeService } from "#src/plugins/pi-agent-ide-changes/src/changes/change-service.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test.each(["present", "cached deletion", "missing index"])(
  "ordinary remote Git tools restore a %s index on its repository owner",
  async (indexState) => {
    const fixture = await startSshFixture();
    const base = path.resolve(".tmp/ssh-git-tests");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "workspace-"));
    const target = {
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    };
    const scope = `ssh://fixture${fixture.workspace}`;
    const file = `${scope}/note.txt`;
    const registry = new SshBackendRegistry([target]);
    const owner = registry.resolve(file);
    if (!owner) throw new Error("Missing fixture owner");
    const executor = createOwnedGitExecutor(
      {
        exec: async () => {
          throw new Error("Unexpected local execution");
        },
      },
      registry,
    );
    const git = async (args: string[]) => {
      const result = await executor.exec("git", args, { cwd: scope });
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    try {
      await git(["init", "--quiet"]);
      await git(["config", "user.name", "Test"]);
      await git(["config", "user.email", "test@example.com"]);
      const revision = await owner.backend.write(
        owner.location.path,
        Buffer.from("before\n"),
        null,
      );
      await git(["add", "note.txt"]);
      await git(["commit", "--quiet", "-m", "base"]);
      await owner.backend.write(owner.location.path, Buffer.from("after café\n"), revision);
      const creation = await ChangeService.create(executor, scope);
      if (creation.status !== "ready") throw new Error(creation.message);
      const inspection = await creation.service.inspect({
        source: file,
        cwd: scope,
        worktreeText: "after café\n",
      });
      if (inspection.status !== "applicable" || !inspection.groups[0])
        throw new Error("Missing initial Git change");
      const change = inspection.groups[0].selector;
      let missingChange: string | undefined;
      if (indexState !== "present") {
        if (indexState === "cached deletion") await git(["rm", "--cached", "note.txt"]);
        else {
          const removal = await executor.exec("bash", ["-c", "rm -- .git/index"], { cwd: scope });
          expect(removal.code, removal.stderr).toBe(0);
        }
        const missingInspection = await creation.service.inspect({
          source: file,
          cwd: scope,
          worktreeText: "after café\n",
        });
        if (missingInspection.status !== "applicable" || !missingInspection.groups[0])
          throw new Error("Missing deleted index change");
        missingChange = missingInspection.groups[0].selector;
      }
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
        JSON.stringify({ targets: [target] }),
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
            "ide.diagnostics",
            "ide.debugger",
            "ide.terminal",
            "ide.vision",
          ],
        }),
      );
      const calls = [
        ...(missingChange === undefined
          ? []
          : [
              { id: "read-deleted", name: "read", arguments: { path: file, views: ["changes"] } },
              { id: "restore-entry", name: "unstage", arguments: { file, change: missingChange } },
            ]),
        { id: "read-changes", name: "read", arguments: { path: file, views: ["changes"] } },
        { id: "stage", name: "stage", arguments: { file, change } },
        { id: "read-staged", name: "read", arguments: { path: file, views: ["changes"] } },
        { id: "unstage", name: "unstage", arguments: { file, change } },
        { id: "stage-again", name: "stage", arguments: { file, change } },
        { id: "undo", name: "undo", arguments: { file, change } },
        { id: "read-restored", name: "read", arguments: { path: file } },
      ];
      const run = await new PiIntegrationTest({
        testName: "ssh-git-tools",
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts")],
        tools: ["read", "stage", "unstage", "undo"],
        timeoutMs: 90_000,
        conversation: [
          ...calls.map((call) => assistantMessage([toolCall(call)])),
          assistantMessage([text("Verified.")]),
        ],
      }).run("Use ordinary Git tools on the configured remote repository.");
      for (const call of calls) expect(getToolExecution(run, call.id).isError, call.id).toBe(false);
      if (missingChange !== undefined)
        expect(getToolResultText(run, "read-deleted")).toContain(missingChange);
      expect(getToolResultText(run, "read-changes")).toContain(change);
      expect(getToolResultText(run, "read-staged")).toContain("staged");
      expect(getToolResultText(run, "read-restored")).toContain("before");
      expect(await git(["show", ":note.txt"])).toBe("before\n");
      expect((await owner.backend.read(owner.location.path)).bytes.toString("utf8")).toBe(
        "before\n",
      );
      expect(run.tuiRenderedOutput).toContain("CHANGE#");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await fixture.stop();
    }
  },
  120_000,
);
