import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { SshBackend } from "#src/backend/ssh.ts";
import { remotePython } from "#src/backend/ssh-transport.ts";
import {
  selectedDirections,
  startTargetFixture,
  type SshTargetFixture,
} from "#integration/support/ssh-target-fixture.ts";

const sample = Buffer.concat([Buffer.from([0, 255, 128, 13, 10]), Buffer.from("café ü\r\nend")]);

describe.each(selectedDirections())("SSH direction %s", (direction) => {
  const targetOs = direction.endsWith(">windows") ? "windows" : "linux";
  let fixture: SshTargetFixture;
  let stopFixture: (() => Promise<void>) | undefined;
  let backend: SshBackend;
  beforeAll(async () => {
    fixture = await startTargetFixture(targetOs);
    stopFixture = () => fixture.stop();
    backend = new SshBackend(fixture.target);
    await fixture.put("data.bin", sample);
    await fixture.put("nested café/inner.txt", "inner\n");
  }, 240_000);
  afterAll(async () => {
    await stopFixture?.();
  }, 60_000);

  test("reads exact bytes, byte ranges and file metadata", async () => {
    const file = fixture.canonical("data.bin");
    expect((await backend.read(file)).bytes.equals(sample)).toBe(true);
    const range = await backend.readRange(file, 3, 6);
    expect(range.bytes.equals(sample.subarray(3, 9))).toBe(true);
    expect(range).toMatchObject({ offset: 3, totalBytes: sample.length });
    expect(await backend.stat(file)).toMatchObject({ kind: "file", size: sample.length });
    expect(await backend.stat(fixture.workspace)).toMatchObject({ kind: "directory" });
  });

  test("lists directories and resolves paths", async () => {
    const entries = await backend.list(fixture.workspace);
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: "data.bin", kind: "file" },
        { name: "nested café", kind: "directory" },
      ]),
    );
    const home = await backend.realpath(fixture.workspace);
    const resolved = await backend.realpath(fixture.canonical("nested café/inner.txt"));
    const normalize = (value: string) => (targetOs === "windows" ? value.toLowerCase() : value);
    expect(normalize(resolved)).toBe(normalize(`${home}/nested café/inner.txt`));
  });

  test("reports a missing file as an unapplied failure", async () => {
    await expect(backend.read(fixture.canonical("missing.txt"))).rejects.toMatchObject({
      code: "ENOENT",
      effect: "not-applied",
    });
  });

  test("runs a program with exact arguments, cwd, binary output and exit status", async () => {
    const result = await backend.execute(
      remotePython(
        "import json,os,sys\nsys.stdout.buffer.write(bytes([0,255,13,10]))\nprint(json.dumps([os.getcwd(),sys.argv[1:]]),file=sys.stderr)\nsys.exit(7)",
      ),
      ["two words", "café", "semi;colon"],
      fixture.canonical("nested café"),
    );
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toEqual(Buffer.from([0, 255, 13, 10]));
    const [cwd, args] = JSON.parse(result.stderr.toString("utf8")) as [string, string[]];
    expect(cwd.replaceAll("\\", "/").endsWith("/nested café")).toBe(true);
    expect(args).toEqual(["two words", "café", "semi;colon"]);
  });

  test("streams stdin and stdout through a service channel", async () => {
    const channel = await backend.startProcess(
      remotePython(
        "import sys\ndata=sys.stdin.buffer.read()\nsys.stdout.buffer.write(data[::-1])\nsys.stdout.buffer.flush()\nsys.exit(5)",
      ),
      [],
      fixture.workspace,
    );
    const chunks: Buffer[] = [];
    channel.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    channel.stderr.resume();
    await channel.write(Buffer.from([1, 2, 3, 255]));
    await channel.end();
    await expect(channel.completion).resolves.toEqual({ exitCode: 5 });
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([255, 3, 2, 1]));
  });

  test.runIf(targetOs === "windows")(
    "refuses to replace a file another process holds open, without changing it",
    async () => {
      const file = fixture.canonical("held.txt");
      const version = await backend.write(file, Buffer.from("before\r\n"), null);
      // Open without sharing, as an editor or a running program may hold a file.
      const holder = await backend.startProcess(
        remotePython(
          "import ctypes,sys\nk=ctypes.WinDLL('kernel32',use_last_error=True)\nk.CreateFileW.restype=ctypes.c_void_p\nk.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p]\nh=k.CreateFileW(sys.argv[1],0xC0000000,0,None,3,0x80,None)\nprint('held' if h not in (None,ctypes.c_void_p(-1).value) else 'failed',flush=True)\nsys.stdin.read()",
        ),
        [file.slice(1).replaceAll("/", "\\")],
        fixture.workspace,
      );
      holder.stderr.resume();
      try {
        const opened = await new Promise<string>((resolve) =>
          holder.stdout.once("data", (bytes: Buffer) => resolve(bytes.toString().trim())),
        );
        expect(opened).toBe("held");
        await expect(backend.write(file, Buffer.from("after\r\n"), version)).rejects.toMatchObject({
          code: "FILE_IN_USE",
          effect: "not-applied",
        });
      } finally {
        await holder.end();
        await holder.completion;
      }
      expect((await fixture.get("held.txt")).toString("latin1")).toBe("before\r\n");
    },
  );
});
