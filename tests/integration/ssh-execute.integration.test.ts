import { probeOwnedCommandCancellation } from "#integration/support/ssh-command-probe.js";
import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";

test.each(["cancel", "deadline"] as const)(
  "ordinary SSH execute %s reaps its native command before returning, without rolling back its write",
  async (mode) => {
    const proof = await probeOwnedCommandCancellation(mode, "execute");
    expect(proof.nativeGoneBeforeTeardown).toBe(true);
    expect(proof.siblingAliveBeforeTeardown).toBe(true);
    expect(proof.sourcePreserved).toBe(true);
    expect(proof.changedSource).toBe('label = "café after command"\n');
    expect(proof.code).toBe(mode === "cancel" ? "CANCELLED" : "TIMEOUT");
    expect(proof.effect).toBe("unknown");
  },
  20000,
);

test("ordinary SSH execute keeps exact argv, native cwd, EOF and binary output on a nonzero exit", async () => {
  const fixture = await startSshFixture({}, { OWNER_ONLY: "native-café" });
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const owner = registry.resolve(`ssh://fixture${fixture.workspace}`);
  if (!owner) throw new Error("Missing fixture owner");
  const backend = owner.backend;
  try {
    const cwd = `${fixture.workspace}/nested café`;
    await backend.execute(
      "python3",
      ["-c", "import os,sys; os.mkdir(sys.argv[1])", cwd],
      fixture.workspace,
    );
    const result = await backend.execute(
      "python3",
      [
        "-c",
        "import json,os,sys; assert sys.stdin.buffer.read()==b''; sys.stdout.buffer.write(bytes([0,255,128,13,10])); print(json.dumps([os.getcwd(),sys.argv[1:],os.getenv('OWNER_ONLY')],ensure_ascii=False),file=sys.stderr); sys.exit(7)",
        "literal ; $(false)",
        "café",
      ],
      cwd,
    );
    expect(result.stdout).toEqual(Buffer.from([0, 255, 128, 13, 10]));
    expect(result.exitCode).toBe(7);
    // This argv fits the native OS limit and must not inherit the smaller control-frame limit.
    await expect(
      backend.execute(
        "python3",
        ["-c", "import sys; print(len(sys.argv[1]))", "x".repeat(70000)],
        cwd,
      ),
    ).resolves.toMatchObject({ stdout: Buffer.from("70000\n"), exitCode: 0 });
    expect(JSON.parse(result.stderr.toString("utf8"))).toEqual([
      cwd,
      ["literal ; $(false)", "café"],
      "native-café",
    ]);
    await expect(backend.execute("lpt149-no-such-native-command", [], cwd)).rejects.toMatchObject({
      code: "ENOENT",
      effect: "not-applied",
    });
    await expect(backend.execute("python3", [], cwd, { timeoutMs: 0 })).rejects.toThrow(
      "must be positive",
    );
    const controller = new AbortController();
    const reason = new Error("Cancel before native execution");
    controller.abort(reason);
    await expect(backend.execute("python3", [], cwd, { signal: controller.signal })).rejects.toBe(
      reason,
    );
  } finally {
    await fixture.stop();
  }
}, 15000);

test("short native programs keep their actual exits when stdin is unused", async () => {
  const fixture = await startSshFixture();
  const project = `ssh://fixture${fixture.workspace}`;
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const owner = registry.resolve(project);
  if (!owner) throw Error("Missing owned command fixture");
  try {
    for (const code of [0, 7, 0, 7, 0, 7]) {
      const result = await owner.backend.execute(
        "/bin/sh",
        ["-c", `printf 'owned café\\n'; exit ${code}`],
        fixture.workspace,
      );
      expect(result.exitCode).toBe(code);
      expect(result.stdout.toString("utf8")).toBe("owned café\n");
      expect(result.stderr.length).toBe(0);
    }
  } finally {
    await fixture.stop();
  }
}, 15000);
test.each(["stdout", "stderr"] as const)(
  "ordinary SSH execute bounds %s and reaps its exact native producer",
  async (stream) => {
    const fixture = await startSshFixture();
    const project = `ssh://fixture${fixture.workspace}`;
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const owner = registry.resolve(project);
    if (!owner) throw new Error("Missing fixture owner");
    const backend = owner.backend;
    const marker = `${fixture.workspace}/producer.pid`;
    try {
      await expect(
        backend.execute(
          "python3",
          [
            "-c",
            "import os,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); out=getattr(sys,sys.argv[2]).buffer\nwhile True: out.write(b'x'*65536); out.flush()",
            marker,
            stream,
          ],
          fixture.workspace,
        ),
      ).rejects.toMatchObject({ code: "CONTENT_LIMIT", effect: "unknown" });
      const pid = Number((await backend.read(marker)).bytes.toString("utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("No exact native producer PID");
      await expect(readSshProcessMetadata(registry, project, pid)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fixture.stop();
    }
  },
  20000,
);
