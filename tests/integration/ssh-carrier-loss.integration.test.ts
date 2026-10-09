import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { startSshCarrierFixture } from "#integration/support/ssh-carrier-fixture.js";
import { SshBackend, SshBackendError } from "#src/backend/ssh.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import type { SshProcessChannel } from "#src/backend/ssh-channel.js";

test.each(["pipe", "pty", "execute"] as const)(
  "real SSH TCP carrier loss keeps %s unknown and reconciles only its native command",
  async (kind) => {
    const fixture = await startSshCarrierFixture();
    const backend = new SshBackend(fixture.target);
    const project = `ssh://fixture${fixture.workspace}`;
    const registry = new SshBackendRegistry([fixture.direct.target]);
    const source = `${fixture.workspace}/note.py`;
    const marker = `${fixture.workspace}/command.pid`;
    const release = `${fixture.workspace}/release`;
    let channel: SshProcessChannel | undefined;
    let sibling: SshProcessChannel | undefined;
    let pending: Promise<unknown> | undefined;
    let pid: number | undefined;
    try {
      sibling = await fixture.direct.startProcess(
        "python3",
        ["-c", "import time; time.sleep(30)"],
        fixture.workspace,
      );
      sibling.stdout.resume();
      sibling.stderr.resume();
      const script = await readFile("tests/integration/fixtures/configured-owner-wait.py", "utf8");
      const args = ["-c", script, source, marker, release];
      if (kind === "execute") {
        pending = backend
          .execute("python3", args, fixture.workspace, { timeoutMs: 15000 })
          .catch((error: unknown) => error);
      } else {
        channel = await backend.startProcess(
          "python3",
          args,
          fixture.workspace,
          kind === "pty" ? { pty: { cols: 80, rows: 24 } } : {},
        );
        channel.stdout.resume();
        channel.stderr.resume();
        pending = channel.completion.catch((error: unknown) => error);
      }
      const observed = await fixture.direct.execute(
        "python3",
        [
          "-c",
          "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); end=time.monotonic()+3\nwhile not p.exists() and time.monotonic()<end: time.sleep(.02)\nprint(p.read_text() if p.exists() else 'missing')",
          marker,
        ],
        fixture.workspace,
      );
      pid = Number(observed.stdout.toString("utf8").trim());
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("No exact native command PID");
      if (channel) expect(pid).toBe(channel.pid);
      const before = (await readSshProcessMetadata(registry, project, pid))[0];
      expect(before?.identity).toBeDefined();
      expect(await fixture.dropConnections()).toBe(1);
      const failure = await pending;
      const failures: unknown[] = failure instanceof AggregateError ? failure.errors : [failure];
      expect(failures.length).toBeGreaterThan(0);
      for (const error of failures) {
        expect(error).toBeInstanceOf(SshBackendError);
        expect(error).toMatchObject({ code: "TRANSPORT_FAILED", effect: "unknown" });
      }
      // A lost carrier cannot acknowledge death. Reconcile through a separate real connection.
      const gone = await fixture.direct.execute(
        "python3",
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
      expect((await readSshProcessMetadata(registry, project, sibling.pid))[0]?.identity).toBe(
        sibling.identity,
      );
      expect((await fixture.direct.read(source)).bytes.toString("utf8")).toBe(
        'label = "café after command"\n',
      );
      // New traffic through the same proxy still works; only the selected live connection was cut.
      expect((await backend.read(source)).bytes.toString("utf8")).toBe(
        'label = "café after command"\n',
      );
    } finally {
      await fixture.direct.write(release, Buffer.from("release\n"), null);
      await pending;
      if (pid !== undefined) {
        const gone = await fixture.direct.execute(
          "python3",
          [
            "-c",
            "import pathlib,sys,time; p=pathlib.Path('/proc')/sys.argv[1]; end=time.monotonic()+3\nwhile p.exists() and time.monotonic()<end: time.sleep(.02)\nprint('alive' if p.exists() else 'gone')",
            String(pid),
          ],
          fixture.workspace,
        );
        expect(gone.stdout.toString("utf8")).toBe("gone\n");
      }
      await sibling?.stop();
      await fixture.stop();
    }
  },
  25000,
);
