import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { findRepositoryRoot } from "#scripts/repository-root.ts";
import { runProcess } from "#capabilities/sandbox.ts";

const script = path.join(
  findRepositoryRoot(import.meta.url),
  "benchmarks/tool-capabilities/prepare-colgrep.sh",
);

test("ColGREP asset installation never overwrites an existing destination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-colgrep-assets-"));
  try {
    const assets = path.join(root, "assets");
    await mkdir(assets);
    await writeFile(path.join(assets, "sentinel"), "EXISTING\n");
    expect((await runProcess("bash", [script, "--download", assets])).code).not.toBe(0);
    expect(await readFile(path.join(assets, "sentinel"), "utf8")).toBe("EXISTING\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unverified runtime download is never published and its staging is removed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-colgrep-assets-"));
  try {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const payload = path.join(root, "payload");
    await mkdir(payload);
    await writeFile(path.join(payload, "untrusted.txt"), "UNTRUSTED\n");
    const archive = path.join(root, "runtime.tgz");
    expect((await runProcess("tar", ["-czf", archive, "-C", payload, "."])).code).toBe(0);
    const requests = path.join(root, "requests");
    await writeFile(
      path.join(bin, "curl"),
      `#!/bin/sh\nwhile [ "$1" != --output ]; do shift; done\nprintf x >> "${requests}"\ncp "${archive}" "$2"\n`,
      { mode: 0o755 },
    );
    const assets = path.join(root, "assets");
    const result = await runProcess("bash", [script, "--download", assets], {
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
    });
    expect(result.code).not.toBe(0);
    await expect(access(assets)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.startsWith("assets.tmp-"))).toEqual([]);
    expect(await readFile(requests, "utf8")).toBe("x");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["missing", "changed"])(
  "%s assets fail before starting the engine or downloading",
  async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "capability-colgrep-assets-"));
    try {
      const bin = path.join(root, "bin");
      await mkdir(bin);
      const marker = path.join(root, "started");
      for (const executable of ["colgrep", "curl"])
        await writeFile(path.join(bin, executable), `#!/bin/sh\nprintf started > "${marker}"\n`, {
          mode: 0o755,
        });
      const assets = path.join(root, "assets");
      if (kind === "changed") {
        await mkdir(assets);
        const hash = createHash("sha256").update("ORIGINAL").digest("hex");
        await writeFile(path.join(assets, "checksums.sha256"), `${hash}  model.onnx\n`);
        await writeFile(path.join(assets, "model.onnx"), "CHANGED");
      }
      const result = await runProcess("bash", [script], {
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          CAPABILITY_COLGREP_ASSETS: assets,
        },
      });
      expect(result.code).not.toBe(0);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
