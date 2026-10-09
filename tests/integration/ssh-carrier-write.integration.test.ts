import path from "node:path";
import { expect, test } from "vitest";
import { startSshCarrierFixture } from "#integration/support/ssh-carrier-fixture.js";
import { SshBackend, SshBackendError } from "#src/backend/ssh.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";

test.each(["before", "after"])(
  "real SSH carrier loss %s commit keeps the write unknown and preserves independent file evidence",
  async (phase) => {
    const fixture = await startSshCarrierFixture(
      { python3: path.resolve("tests/integration/fixtures/ssh-carrier-write-gate.py") },
      { CARRIER_WRITE_PHASE: phase },
    );
    const file = `${fixture.workspace}/carrier-owned.txt`;
    const marker = `${fixture.workspace}/carrier-write-ready`;
    const release = `${fixture.workspace}/carrier-write-release`;
    const project = `ssh://fixture${fixture.workspace}`;
    const registry = new SshBackendRegistry([fixture.direct.target]);
    let pending: Promise<unknown> | undefined;
    let pid: number | undefined;
    try {
      const original = Buffer.from("before café\n");
      const changed = Buffer.from("after café\n");
      const expected = await fixture.direct.write(file, original, null);
      const backend = new SshBackend(fixture.target);
      pending = backend.write(file, changed, expected).catch((error: unknown) => error);
      const observed = await fixture.direct.execute(
        "/usr/bin/python3",
        [
          "-c",
          "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); end=time.monotonic()+3\nwhile not p.exists() and time.monotonic()<end: time.sleep(.02)\nprint(p.read_text() if p.exists() else '{}')",
          marker,
        ],
        fixture.workspace,
      );
      const receipt: unknown = JSON.parse(observed.stdout.toString("utf8"));
      if (
        !receipt ||
        typeof receipt !== "object" ||
        !("pid" in receipt) ||
        typeof receipt.pid !== "number" ||
        !Number.isSafeInteger(receipt.pid) ||
        receipt.pid < 1 ||
        !("phase" in receipt) ||
        receipt.phase !== phase
      )
        throw new Error("No exact owned native write gate");
      pid = receipt.pid;
      expect((await readSshProcessMetadata(registry, project, pid))[0]?.pid).toBe(pid);
      // Independent evidence establishes which side of commit the real socket cut occurs on.
      expect((await fixture.direct.read(file)).bytes).toEqual(
        phase === "after" ? changed : original,
      );
      expect(await fixture.dropConnections()).toBe(1);
      const failure = await pending;
      // A lost carrier cannot acknowledge owned cleanup. Keep both failures, not a false success.
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("Missing carrier cleanup failures");
      expect(failure.errors).toHaveLength(2);
      for (const error of failure.errors) {
        expect(error).toBeInstanceOf(SshBackendError);
        expect(error).toMatchObject({ code: "TRANSPORT_FAILED", effect: "unknown" });
      }
      expect(failure.errors[0]).toMatchObject({ source: `${project}/carrier-owned.txt` });
      await expect(readSshProcessMetadata(registry, project, pid)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await fixture.direct.read(file)).bytes).toEqual(
        phase === "after" ? changed : original,
      );
      const external = Buffer.from("external café edit\n");
      const current = await fixture.direct.read(file);
      await fixture.direct.write(file, external, current.version);
      await expect(
        backend.write(file, Buffer.from("blind retry\n"), expected),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        effect: "not-applied",
      });
      expect((await fixture.direct.read(file)).bytes).toEqual(external);
    } finally {
      // The owned flag releases only the test gate; no guessed numeric PID is signalled.
      await fixture.direct.write(release, Buffer.from("release\n"), null);
      await pending;
      if (pid !== undefined) {
        const gone = await fixture.direct.execute(
          "/usr/bin/python3",
          [
            "-c",
            "import pathlib,sys,time; p=pathlib.Path('/proc')/sys.argv[1]; end=time.monotonic()+3\nwhile p.exists() and time.monotonic()<end: time.sleep(.02)\nprint('alive' if p.exists() else 'gone')",
            String(pid),
          ],
          fixture.workspace,
        );
        expect(gone.stdout.toString("utf8")).toBe("gone\n");
        await expect(readSshProcessMetadata(registry, project, pid)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await fixture.stop();
    }
  },
  60000,
);
