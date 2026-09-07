import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { DoctorCore } from "./core.js";
import { inspectDoctorSetup } from "./run.js";
import { formatterDoctorPlugin } from "#src/plugins/pi-agent-ide-formatter/src/doctor-plugin.js";
import { lintDoctorPlugin } from "#src/plugins/pi-agent-ide-lint/src/doctor-plugin.js";

// Real executable files test discovery, not formatter or linter output.
test("rechecks executable availability after dependencies appear in a real worktree", async () => {
  const parent = path.resolve(".agents/tmp/doctor-worktree-test");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "run-"));
  const base = path.join(root, "base");
  const worktree = path.join(root, "linked");
  const git = promisify(execFile);
  try {
    await git("git", ["init", "--quiet", base]);
    await git("git", [
      "-C",
      base,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    await git("git", ["-C", base, "worktree", "add", "--detach", worktree]);
    await writeFile(
      path.join(worktree, "package.json"),
      '{"devDependencies":{"oxfmt":"*","oxlint":"*"}}\n',
    );
    await writeFile(path.join(worktree, "input.ts"), "export const value = 1;\n");
    const core = new DoctorCore();
    await core.registerPlugin(formatterDoctorPlugin);
    await core.registerPlugin(lintDoctorPlugin);
    const snapshot = {
      ...core.snapshot(),
      languages: [
        {
          pluginId: "languages",
          value: { id: "typescript", name: "TypeScript", extensions: [".ts"] },
        },
      ],
    };
    const inspect = () => inspectDoctorSetup(snapshot, worktree, { PATH: "" });
    const ids = (result: Awaited<ReturnType<typeof inspect>>) =>
      result.actions.map((action) => action.id);
    expect(ids(await inspect())).toEqual(
      expect.arrayContaining(["formatter-oxfmt-unavailable", "linter-oxlint-unavailable"]),
    );
    const bin = path.join(worktree, "node_modules/.bin");
    await mkdir(bin, { recursive: true });
    for (const tool of ["oxfmt", "oxlint"])
      await symlink(
        process.execPath,
        path.join(bin, `${tool}${process.platform === "win32" ? ".exe" : ""}`),
      );
    const ready = await inspect();
    expect(ids(ready)).not.toContain("formatter-oxfmt-unavailable");
    expect(ids(ready)).not.toContain("linter-oxlint-unavailable");
    expect(
      ready.candidates
        .filter((candidate) => ["oxfmt", "oxlint"].includes(candidate.recipe.id))
        .every((candidate) => candidate.executable !== undefined),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
