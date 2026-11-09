import { requiredValue } from "pi-agent-invariant";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { ChangeService } from "#src/changes/change-service.ts";

import type { GitCommandExecutor, GitCommandResult } from "#src/changes/git-changes-backend.ts";

const runFile = promisify(execFile);
// Partial commits expose their temporary index to hooks. Test repositories must use their own index.
const gitEnvironment = { ...process.env };
delete gitEnvironment.GIT_INDEX_FILE;

function runGit(args: readonly string[], cwd: string) {
  return runFile("git", args, { cwd, env: gitEnvironment });
}

const temporaryDirectories: string[] = [];

const executor: GitCommandExecutor = {
  async exec(command, args, options): Promise<GitCommandResult> {
    try {
      const result = await runFile(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        env: gitEnvironment,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
      };
    }
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createRepository(
  headText = "one\ntwo\nthree\n",
): Promise<{ directory: string; file: string; service: ChangeService }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-changes-domain-"));
  const file = path.join(directory, "tracked.txt");
  temporaryDirectories.push(directory);
  await runGit(["init", "--quiet"], directory);
  await runGit(["config", "user.email", "test@example.com"], directory);
  await runGit(["config", "user.name", "Test"], directory);
  await writeFile(file, headText, "utf8");
  await runGit(["add", "tracked.txt"], directory);
  await runGit(["commit", "--quiet", "-m", "base"], directory);
  const creation = await ChangeService.create(executor, directory);
  expect(creation.status).toBe("ready");

  if (creation.status !== "ready") {
    throw new Error(creation.message);
  }

  return { directory, file, service: creation.service };
}

function inspectCurrent(
  service: ChangeService,
  directory: string,
  file: string,
  worktreeText: string,
) {
  return service.inspect({ source: file, worktreeText, cwd: directory });
}

async function indexText(directory: string): Promise<string> {
  return (await runGit(["show", ":tracked.txt"], directory)).stdout;
}

describe("Git change domain", () => {
  test.each([
    ["replacement", "one\nchanged\nthree\n"],
    ["insertion", "one\ntwo\ninserted\nthree\n"],
    ["deletion", "one\nthree\n"],
    ["CRLF", "one\r\ntwo\r\nthree\r\n"],
    ["missing final newline", "one\ntwo\nthree"],
  ])("prepares an exact %s undo", async (_name, worktreeText) => {
    const { directory, file, service } = await createRepository();
    const inspection = await inspectCurrent(service, directory, file, worktreeText);
    expect(inspection.status).toBe("applicable");

    if (inspection.status !== "applicable") {
      return;
    }

    const result = await service.prepareUndo(
      { source: file, worktreeText, cwd: directory },
      requiredValue(inspection.groups[0]).selector,
    );
    expect(result).toMatchObject({ status: "applied", worktreeText: "one\ntwo\nthree\n" });
  });

  test("stages and unstages one stable change anchor", async () => {
    const { directory, file, service } = await createRepository();
    const worktreeText = "one\nchanged\nthree\n";
    await writeFile(file, worktreeText, "utf8");
    const first = await inspectCurrent(service, directory, file, worktreeText);
    expect(first.status).toBe("applicable");

    if (first.status !== "applicable") {
      return;
    }

    const selector = requiredValue(first.groups[0]).selector;
    expect(requiredValue(first.groups[0]).state).toBe("unstaged");
    await expect(
      service.changeIndex({ source: file, worktreeText, cwd: directory }, selector, "stage"),
    ).resolves.toMatchObject({ status: "applied", state: "staged" });
    expect(await indexText(directory)).toBe(worktreeText);

    const staged = await inspectCurrent(service, directory, file, worktreeText);
    expect(staged).toMatchObject({
      status: "applicable",
      groups: [{ selector, state: "staged" }],
    });
    await expect(
      service.changeIndex({ source: file, worktreeText, cwd: directory }, selector, "unstage"),
    ).resolves.toMatchObject({ status: "applied", state: "unstaged" });
    expect(await indexText(directory)).toBe("one\ntwo\nthree\n");

    const unstaged = await inspectCurrent(service, directory, file, worktreeText);
    expect(unstaged).toMatchObject({
      status: "applicable",
      groups: [{ selector, state: "unstaged" }],
    });
  });

  test("replaces a partial index region with the selected worktree or HEAD state", async () => {
    const { directory, file, service } = await createRepository();
    await writeFile(file, "one\nstaged\nthree\n", "utf8");
    await runGit(["add", "tracked.txt"], directory);
    const worktreeText = "one\nworking\nthree\n";
    await writeFile(file, worktreeText, "utf8");
    const inspection = await inspectCurrent(service, directory, file, worktreeText);
    expect(inspection.status).toBe("applicable");

    if (inspection.status !== "applicable") {
      return;
    }

    const selector = requiredValue(inspection.groups[0]).selector;
    expect(requiredValue(inspection.groups[0]).state).toBe("partial");
    await service.changeIndex({ source: file, worktreeText, cwd: directory }, selector, "stage");
    expect(await indexText(directory)).toBe(worktreeText);
    await service.changeIndex({ source: file, worktreeText, cwd: directory }, selector, "unstage");
    expect(await indexText(directory)).toBe("one\ntwo\nthree\n");
  });

  test("undo removes a staged change from both states", async () => {
    const { directory, file, service } = await createRepository();
    const worktreeText = "one\nchanged\nthree\n";
    await writeFile(file, worktreeText, "utf8");
    const inspection = await inspectCurrent(service, directory, file, worktreeText);

    if (inspection.status !== "applicable") {
      throw new Error("expected a current change");
    }

    const selector = requiredValue(inspection.groups[0]).selector;
    await service.changeIndex({ source: file, worktreeText, cwd: directory }, selector, "stage");
    const undo = await service.prepareUndo(
      { source: file, worktreeText, cwd: directory },
      selector,
    );
    expect(undo.status).toBe("applied");

    if (undo.status !== "applied") {
      return;
    }

    expect(undo.worktreeText).toBe("one\ntwo\nthree\n");
    expect(undo.indexUpdate).toBeDefined();

    if (undo.indexUpdate !== undefined) {
      await service.applyIndexUpdate(undo.indexUpdate);
    }

    expect(await indexText(directory)).toBe("one\ntwo\nthree\n");
  });

  test("undo preserves a distant change", async () => {
    const headText = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join("");
    const { directory, file, service } = await createRepository(headText);
    const worktreeText = headText.replace("line 1\n", "first\n").replace("line 18\n", "last\n");
    const inspection = await inspectCurrent(service, directory, file, worktreeText);
    expect(inspection.status).toBe("applicable");

    if (inspection.status !== "applicable") {
      return;
    }

    expect(inspection.groups).toHaveLength(2);
    const result = await service.prepareUndo(
      { source: file, worktreeText, cwd: directory },
      requiredValue(inspection.groups[0]).selector,
    );
    expect(result).toMatchObject({
      status: "applied",
      worktreeText: headText.replace("line 18\n", "last\n"),
    });
  });

  test("reports files where changes are not applicable or unavailable", async () => {
    const { directory, file, service } = await createRepository();
    expect(await inspectCurrent(service, directory, file, "one\ntwo\nthree\n")).toEqual({
      status: "not-applicable",
      reason: "clean",
    });
    expect(
      await inspectCurrent(service, directory, path.join(directory, "new.txt"), "new\n"),
    ).toEqual({ status: "not-applicable", reason: "untracked" });
    expect(
      await inspectCurrent(
        service,
        directory,
        // oxlint-disable-next-line repo/no-parent-paths -- defensive check against traversal, not a traversal
        path.join(directory, "..", "outside.txt"),
        "outside\n",
      ),
    ).toMatchObject({ status: "unavailable", reason: "outside-worktree" });
    expect(await inspectCurrent(service, directory, file, "binary\0text")).toMatchObject({
      status: "unavailable",
      reason: "binary",
    });
  });
});

describe("Git line-ending conversion", () => {
  const head = "one\ntwo\nthree\n";
  const crlf = "one\r\nchanged\r\nthree\r\n";

  async function convertingRepository(configure: (directory: string) => Promise<void>) {
    const repository = await createRepository(head);
    await configure(repository.directory);
    await writeFile(repository.file, crlf, "utf8");
    return repository;
  }
  const autocrlf = async (directory: string) => {
    await runGit(["config", "core.autocrlf", "true"], directory);
  };
  const attribute = async (directory: string) => {
    await writeFile(path.join(directory, ".gitattributes"), "*.txt text eol=crlf\n", "utf8");
  };

  test.each([
    ["core.autocrlf", autocrlf],
    ["an eol attribute", attribute],
  ])("a CRLF worktree matches LF blobs with %s", async (_name, configure) => {
    const { directory, file, service } = await convertingRepository(configure);
    const inspection = await inspectCurrent(service, directory, file, crlf);
    expect(inspection).toMatchObject({ status: "applicable", groups: [{ state: "unstaged" }] });
    if (inspection.status !== "applicable") return;
    const group = requiredValue(inspection.groups[0]);
    expect(group.currentStartLine).toBe(2);
    expect(group.currentEndLine).toBe(2);

    await expect(
      service.changeIndex(
        { source: file, worktreeText: crlf, cwd: directory },
        group.selector,
        "stage",
      ),
    ).resolves.toMatchObject({ status: "applied", state: "staged" });
    expect(await indexText(directory)).toBe("one\nchanged\nthree\n");
    // Git agrees that the staged file has no further worktree change.
    expect((await runGit(["diff", "--name-only"], directory)).stdout).toBe("");
  });

  test("undo restores CRLF in a uniformly CRLF file", async () => {
    const { directory, file, service } = await convertingRepository(autocrlf);
    const inspection = await inspectCurrent(service, directory, file, crlf);
    if (inspection.status !== "applicable") throw new Error("Missing change");
    await expect(
      service.prepareUndo(
        { source: file, worktreeText: crlf, cwd: directory },
        requiredValue(inspection.groups[0]).selector,
      ),
    ).resolves.toMatchObject({ status: "applied", worktreeText: "one\r\ntwo\r\nthree\r\n" });
  });

  test("undo refuses a file that mixes CRLF and LF", async () => {
    const { directory, file, service } = await convertingRepository(autocrlf);
    const mixed = "one\r\nchanged\nthree\r\n";
    const inspection = await inspectCurrent(service, directory, file, mixed);
    if (inspection.status !== "applicable") throw new Error("Missing change");
    await expect(
      service.prepareUndo(
        { source: file, worktreeText: mixed, cwd: directory },
        requiredValue(inspection.groups[0]).selector,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "mixed-line-endings" });
  });

  test("a CRLF worktree is a whole-file change when Git does not convert", async () => {
    const { directory, file, service } = await convertingRepository(async () => {});
    const inspection = await inspectCurrent(service, directory, file, crlf);
    if (inspection.status !== "applicable") throw new Error("Missing change");
    expect(requiredValue(inspection.groups[0]).currentEndLine).toBe(3);
  });
});
