import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { capabilityCases } from "./cases.ts";
import { fixtureFiles, validateFiles } from "./sandbox.ts";

for (const task of capabilityCases.filter((entry) => entry.files?.["Cargo.toml"])) {
  void test(`${task.id} seeds a matching package lock and rejects lock edits or deletion`, async () => {
    assert.ok(task.files);
    const manifestFile = task.files["Cargo.toml"];
    assert.ok(manifestFile);
    const manifest = parse(manifestFile);
    const lockfile = task.files["Cargo.lock"];
    assert.ok(lockfile);
    const lock = parse(lockfile);
    assert.equal(lock.version, 3);
    const pkg = manifest.package as { name: string; version: string };
    assert.deepEqual(
      (lock.package as Record<string, unknown>[]).map((entry) => ({ ...entry })),
      [{ name: pkg.name, version: pkg.version }],
    );

    const root = await mkdtemp(path.join(os.tmpdir(), "capability-rust-"));
    try {
      for (const [file, content] of Object.entries(task.files)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), content);
      }
      const initial = await fixtureFiles(root);
      for (const [file, content] of Object.entries(task.expected ?? {})) {
        if (content === null) await rm(path.join(root, file), { force: true });
        else await writeFile(path.join(root, file), content);
      }
      assert.deepEqual(await validateFiles(root, initial, task.expected), []);
      assert.equal(await readFile(path.join(root, "Cargo.lock"), "utf8"), lockfile);

      await writeFile(path.join(root, "Cargo.lock"), lockfile + "\n");
      assert.notEqual((await validateFiles(root, initial, task.expected)).length, 0);
      await rm(path.join(root, "Cargo.lock"));
      assert.notEqual((await validateFiles(root, initial, task.expected)).length, 0);
      await writeFile(path.join(root, "Cargo.lock"), lockfile);

      if (task.id === "rust-diagnostics-no-build") {
        await writeFile(path.join(root, "build-attempted"), "unexpected");
        assert.notEqual((await validateFiles(root, initial, task.expected)).length, 0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
