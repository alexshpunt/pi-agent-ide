import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixtureFiles, validateFiles } from "./sandbox.ts";

void test("only the Vera case's own index is omitted from file validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-vera-"));
  try {
    const fixture = path.join(root, "fixture");
    await mkdir(path.join(fixture, ".vera"), { recursive: true });
    await mkdir(path.join(fixture, "nested", ".vera"), { recursive: true });
    await mkdir(path.join(root, ".vera"));
    await writeFile(path.join(fixture, ".vera", "index"), "internal");
    await writeFile(path.join(fixture, "nested", ".vera", "important"), "nested");
    await writeFile(path.join(root, ".vera", "outside"), "outside");
    await writeFile(path.join(fixture, "task.ts"), "original");
    const initial = await fixtureFiles(fixture, "", "");
    assert.deepEqual(Object.keys(initial).sort(), ["nested/.vera/important", "task.ts"]);
    assert.ok((await fixtureFiles(root, "", "fixture"))[".vera/outside"]);
    await writeFile(path.join(fixture, ".vera", "index"), "updated");
    assert.deepEqual(await validateFiles(fixture, initial, {}, ""), []);
    await writeFile(path.join(fixture, "task.ts"), "changed");
    assert.equal((await validateFiles(fixture, initial, {}, "")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
