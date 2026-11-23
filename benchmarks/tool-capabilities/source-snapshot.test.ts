import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isMountedPiPath, sandboxArgs, snapshotSource } from "./sandbox.ts";
import { sourceIdentity } from "./source-identity.ts";

void test("freezes source while mounting root and workspace dependencies read-only", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "capability-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "checkout");
  const nested = "packages/example";
  const removed = "packages/removed";
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8" });
  for (const directory of [nested, removed])
    await mkdir(path.join(repository, directory), { recursive: true });
  for (const pkg of ["", nested, removed])
    await writeFile(path.join(repository, pkg, "package.json"), "{}\n");
  await writeFile(path.join(repository, ".gitignore"), "node_modules/\nprivate.txt\n");
  await writeFile(path.join(repository, "tracked.txt"), "original\n");
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Initial",
  );
  await writeFile(path.join(repository, "tracked.txt"), "at snapshot\n");
  await writeFile(path.join(repository, "untracked.txt"), "include\n");
  await writeFile(path.join(repository, "private.txt"), "omit\n");
  await rm(path.join(repository, removed, "package.json"));
  for (const pkg of ["", nested, removed]) {
    const modules = path.join(repository, pkg, "node_modules");
    await mkdir(modules);
    await writeFile(path.join(modules, "dependency.txt"), "installed\n");
  }

  const snapshot = await snapshotSource(repository, root);
  await writeFile(path.join(repository, "node_modules", "dependency.txt"), "changed install\n");
  assert.deepEqual(await sourceIdentity(repository), {
    revision: snapshot.revision,
    sourceDigest: snapshot.digest,
  });
  await writeFile(path.join(repository, "tracked.txt"), "after snapshot\n");
  assert.equal(await readFile(path.join(snapshot.source, "tracked.txt"), "utf8"), "at snapshot\n");
  assert.equal(await readFile(path.join(snapshot.source, "untracked.txt"), "utf8"), "include\n");
  await assert.rejects(readFile(path.join(snapshot.source, "private.txt")), { code: "ENOENT" });
  await assert.rejects(readdir(path.join(snapshot.source, removed, "node_modules")), {
    code: "ENOENT",
  });
  assert.deepEqual(await readdir(path.join(snapshot.source, "node_modules")), []);
  assert.deepEqual(await readdir(path.join(snapshot.source, nested, "node_modules")), []);

  const args = await sandboxArgs(snapshot, root);
  const mount = args.indexOf("/source");
  assert.deepEqual(args.slice(mount - 2, mount + 7), [
    "--ro-bind",
    snapshot.source,
    "/source",
    "--ro-bind",
    path.join(repository, "node_modules"),
    "/source/node_modules",
    "--ro-bind",
    path.join(repository, nested, "node_modules"),
    `/source/${nested}/node_modules`,
  ]);
});

void test("installed Pi must be below a mounted toolchain directory", () => {
  for (const root of [
    "/usr",
    "/opt",
    path.join(os.homedir(), ".local/bin"),
    path.join(os.homedir(), ".local/lib"),
  ]) {
    assert.equal(isMountedPiPath(path.join(root, "pi/cli.js")), true);
    assert.equal(isMountedPiPath(root + "-other/pi/cli.js"), false);
  }
  assert.equal(isMountedPiPath("/source/node_modules/pi/cli.js"), false);
});
