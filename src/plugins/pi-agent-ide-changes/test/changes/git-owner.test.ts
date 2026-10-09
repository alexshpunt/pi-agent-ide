import { expect, test } from "vitest";
import { GitChangesBackend, type GitCommandExecutor } from "#src/changes/git-changes-backend.js";

const root = "ssh://fixture/srv/work";

function executor(calls: string[]): GitCommandExecutor {
  return {
    async exec(_command, args, options) {
      calls.push(options.cwd);
      if (args.includes("--show-toplevel")) return { code: 0, stdout: "/srv/work\n", stderr: "" };
      if (args.includes("--verify")) return { code: 0, stdout: "head\n", stderr: "" };
      if (args.includes("ls-tree"))
        return { code: 0, stdout: "100644 blob original\tnote.txt\0", stderr: "" };
      if (args.includes("ls-files"))
        return { code: 0, stdout: "100644 original 0\tnote.txt\0", stderr: "" };
      return { code: 0, stdout: "before\n", stderr: "" };
    },
  };
}

test("Git repository discovery and blob reads retain the remote owner", async () => {
  const calls: string[] = [];
  const creation = await GitChangesBackend.create(executor(calls), root);
  expect(creation.status).toBe("ready");
  if (creation.status !== "ready") throw new Error(creation.message);
  expect(creation.backend.repositoryRoot).toBe(root);
  expect(await creation.backend.readTrackedFile(`${root}/note.txt`, root)).toMatchObject({
    status: "found",
    repositoryRoot: root,
    repositoryPath: "note.txt",
    headText: "before\n",
  });
  expect(calls.every((cwd) => cwd === root)).toBe(true);
  expect(
    await creation.backend.readTrackedFile("ssh://other/srv/work/note.txt", root),
  ).toMatchObject({
    status: "unavailable",
    reason: "outside-worktree",
  });
});

test("a remote index write without an owner blob writer never uses a local temporary file", async () => {
  const calls: string[] = [];
  const creation = await GitChangesBackend.create(executor(calls), root);
  if (creation.status !== "ready") throw new Error(creation.message);
  await expect(creation.backend.writeIndexFile("note.txt", "100644", "after\n")).rejects.toThrow(
    "Remote Git index writes require a guarded owner index writer",
  );
  expect(calls).toEqual([root]);
});

test.each(["not-applied", "applied", "unknown"] as const)(
  "index failures retain their %s publication effect",
  async (effect) => {
    const { ChangeService } = await import("#src/changes/change-service.js");
    const failure = Object.assign(new Error("GIT_INDEX_CHANGED"), {
      code: "GIT_INDEX_CHANGED",
      effect,
    });
    const owned = {
      ...executor([]),
      writeIndex: async () => {
        throw failure;
      },
    };
    const creation = await ChangeService.create(owned, root);
    if (creation.status !== "ready") throw new Error(creation.message);
    const input = { source: `${root}/note.txt`, cwd: root, worktreeText: "after\n" };
    const inspection = await creation.service.inspect(input);
    if (inspection.status !== "applicable") throw new Error("Missing fixture change");
    const group = inspection.groups[0];
    if (!group) throw new Error("Missing fixture anchor");
    const result = await creation.service.changeIndex(input, group.selector, "stage");
    expect(result).toMatchObject({ status: "unavailable", failure });
  },
);
