import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { SshBackend } from "#src/backend/ssh.ts";
import { remotePython } from "#src/backend/ssh-transport.ts";
import {
  directions,
  sourcePlatform,
  startTargetFixture,
  type Direction,
  type SshTargetFixture,
} from "#integration/support/ssh-target-fixture.ts";

/**
 * Directions to run, written `source>target`. CI names them explicitly, so a direction whose
 * fixture cannot start fails here instead of being skipped. Without the variable, the
 * directions this machine can serve run: Windows targets need a Windows source or WSL interop.
 */
function selectedDirections(): readonly Direction[] {
  const requested = process.env.PI_SSH_COVERAGE_DIRECTIONS;
  if (!requested)
    return directions.filter(
      (direction) =>
        direction.startsWith(sourcePlatform) &&
        (direction !== "linux>windows" || Boolean(process.env.WSL_DISTRO_NAME)),
    );
  return requested.split(",").map((name) => {
    const direction = directions.find((candidate) => candidate === name.trim());
    if (!direction) throw new Error(`Unknown SSH coverage direction: ${name}`);
    if (!direction.startsWith(sourcePlatform))
      throw new Error(
        `${direction} needs a ${direction.split(">")[0]} source, not ${sourcePlatform}`,
      );
    return direction;
  });
}

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
        "import json,os,sys\nsys.stdout.buffer.write(bytes([0,255,13,10]))\nprint(json.dumps([os.getcwd(),sys.argv[1:]],ensure_ascii=False),file=sys.stderr)\nsys.exit(7)",
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
});
