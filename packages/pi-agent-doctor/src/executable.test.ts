import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { isExecutableAvailable } from "./executable.js";

test("does not mistake a directory for an executable", async () => {
  const root = path.resolve(".agents/tmp/executable-tests");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "directory-"));
  try {
    await mkdir(path.join(cwd, "pretend-tool"));
    expect(await isExecutableAvailable("pretend-tool", cwd, { PATH: cwd })).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "preserves literal quote characters in Unix PATH directories",
  async () => {
    const root = path.resolve(".agents/tmp/executable-tests");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "quotes-"));
    try {
      const bin = path.join(cwd, '"native tools"');
      await mkdir(bin);
      const file = path.join(bin, "example");
      await writeFile(file, "#!/bin/sh\nexit 0\n");
      await chmod(file, 0o755);
      expect(await isExecutableAvailable("example", cwd, { PATH: bin })).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
