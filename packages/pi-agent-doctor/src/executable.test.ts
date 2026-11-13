import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { isExecutableAvailable } from "./executable.ts";

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

test("Windows ignores a POSIX-only project shim and accepts a Windows launcher", async () => {
  const root = path.resolve(".agents/tmp/executable-tests");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "windows-shim-"));
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    const bin = path.join(cwd, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "example"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(await isExecutableAvailable("example", cwd, { PATH: "", PATHEXT: ".EXE;.CMD" })).toBe(
      false,
    );
    await writeFile(path.join(bin, "example.cmd"), "@exit /b 0\n", { mode: 0o755 });
    expect(await isExecutableAvailable("example", cwd, { PATH: "", PATHEXT: ".EXE;.CMD" })).toBe(
      true,
    );
    expect(
      await isExecutableAvailable(path.join(bin, "example.cmd"), cwd, {
        PATH: "",
        PATHEXT: ".EXE;.CMD",
      }),
    ).toBe(true);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    await rm(cwd, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("Unix accepts an executable project shim", async () => {
  const root = path.resolve(".agents/tmp/executable-tests");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "unix-shim-"));
  try {
    const bin = path.join(cwd, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "example"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(await isExecutableAvailable("example", cwd, { PATH: "" })).toBe(true);
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
