import { expect, test } from "vitest";
import { createOwnedGitExecutor } from "#src/backend/git-registration.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { ChangeService } from "#src/plugins/pi-agent-ide-changes/src/changes/change-service.js";
import { startSshFixture } from "./support/ssh-fixture.js";

test("Git reads and index changes use the remote repository without local execution", async () => {
  const fixture = await startSshFixture();
  try {
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const cwd = `ssh://fixture${fixture.workspace}`;
    const file = `${cwd}/note.txt`;
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
    const run = async (args: string[]) => {
      const result = await executor.exec("git", args, { cwd });
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    await run(["init", "--quiet"]);
    await run(["config", "user.name", "Test"]);
    await run(["config", "user.email", "test@example.com"]);
    const revision = await owner.backend.write(owner.location.path, Buffer.from("before\n"), null);
    await run(["add", "note.txt"]);
    await run(["commit", "--quiet", "-m", "base"]);
    await owner.backend.write(owner.location.path, Buffer.from("after café\n"), revision);
    const creation = await ChangeService.create(executor, cwd);
    if (creation.status !== "ready") throw new Error(creation.message);
    const input = { source: file, cwd, worktreeText: "after café\n" };
    const inspection = await creation.service.inspect(input);
    expect(inspection.status).toBe("applicable");
    if (inspection.status !== "applicable") throw new Error("Missing Git change");
    expect(inspection.repositoryRoot).toBe(cwd);
    const change = inspection.groups[0];
    if (!change) throw new Error("Missing change anchor");
    expect(await creation.service.changeIndex(input, change.selector, "stage")).toMatchObject({
      status: "applied",
      state: "staged",
    });
    expect(await run(["show", ":note.txt"])).toBe(input.worktreeText);
    expect(await creation.service.changeIndex(input, change.selector, "unstage")).toMatchObject({
      status: "applied",
      state: "unstaged",
    });
    expect(await run(["show", ":note.txt"])).toBe("before\n");
    await expect(
      owner.backend.writeGitIndex(fixture.workspace, {
        repositoryPath: "note.txt",
        mode: "100644",
        text: "rejected\n",
        expectedHead: (await run(["rev-parse", "HEAD"])).trim(),
        expectedIndexText: "not the current index\n",
        expectedIndexMode: "100644",
      }),
    ).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED", effect: "not-applied" });
    expect(await run(["show", ":note.txt"])).toBe("before\n");
    await expect(
      owner.backend.writeGitIndex(fixture.workspace, {
        repositoryPath: "note.txt",
        mode: "100644",
        text: "rejected\n",
        expectedHead: (await run(["rev-parse", "HEAD"])).trim(),
        expectedIndexText: "before\n",
        expectedIndexMode: "100644",
        expectedWorktreeText: "an old worktree snapshot\n",
      }),
    ).rejects.toMatchObject({ code: "GIT_WORKTREE_CHANGED", effect: "not-applied" });
    expect(await run(["show", ":note.txt"])).toBe("before\n");
    await run(["rm", "--cached", "note.txt"]);
    const deletedInspection = await creation.service.inspect(input);
    if (deletedInspection.status !== "applicable") throw new Error("Missing cached deletion");
    const deletedChange = deletedInspection.groups[0];
    if (!deletedChange) throw new Error("Missing cached deletion anchor");
    expect(
      await creation.service.changeIndex(input, deletedChange.selector, "unstage"),
    ).toMatchObject({ status: "applied", state: "unstaged" });
    expect(await run(["show", ":note.txt"])).toBe("before\n");
    await expect(
      owner.backend.writeGitIndex(fixture.workspace, {
        repositoryPath: "note.txt",
        mode: "100644",
        text: "rejected\n",
        expectedHead: (await run(["rev-parse", "HEAD"])).trim(),
        expectedIndexText: "",
        expectedIndexMode: "100644",
        expectedIndexExists: false,
      }),
    ).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED", effect: "not-applied" });
    const removedIndex = await executor.exec("bash", ["-c", "rm -- .git/index"], { cwd });
    expect(removedIndex.code, removedIndex.stderr).toBe(0);
    const absentIndexInspection = await creation.service.inspect(input);
    if (absentIndexInspection.status !== "applicable")
      throw new Error("Missing absent index change");
    const absentIndexChange = absentIndexInspection.groups[0];
    if (!absentIndexChange) throw new Error("Missing absent index anchor");
    expect(
      await creation.service.changeIndex(input, absentIndexChange.selector, "unstage"),
    ).toMatchObject({ status: "applied", state: "unstaged" });
    expect(await run(["show", ":note.txt"])).toBe("before\n");
    await expect(
      executor.exec("git", ["status"], { cwd: "ssh://unknown/tmp" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_TARGET", effect: "not-applied" });
    expect((await owner.backend.read(owner.location.path)).bytes.toString("utf8")).toBe(
      input.worktreeText,
    );
  } finally {
    await fixture.stop();
  }
}, 60_000);
