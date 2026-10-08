import path from "node:path";
import { expect, test } from "vitest";

import { SshBackend } from "#src/backend/ssh.js";

// Explicit opt-in: this check uses a real configured host and installs nothing.
const host = process.env.PI_IDE_SSH_SMOKE_HOST;

test.skipIf(!host)(
  "configured SSH host supports guarded binary IO and exact execution",
  async () => {
    if (!host) throw new Error("Set PI_IDE_SSH_SMOKE_HOST to a trusted SSH alias");
    const backend = new SshBackend({ id: "smoke", host, workspace: "/tmp" });
    const created = await backend.execute(
      "python3",
      ["-c", "import tempfile; print(tempfile.mkdtemp(prefix='.tmp-pi-ide-ssh-'))"],
      "/tmp",
    );
    expect(created.exitCode).toBe(0);
    const directory = created.stdout.toString().trim();
    if (!/^\/tmp\/\.tmp-pi-ide-ssh-[a-zA-Z0-9_-]+$/.test(directory))
      throw new Error("Unexpected temporary workspace");
    const filename = path.posix.join(directory, "bytes #?% ' ;.bin");
    let exists = false;
    const copied = path.posix.join(directory, "copied #?%.bin");
    let copyExists = false;
    try {
      const bytes = Buffer.from([0, 255, 128, 10, 13, 1]);
      const version = await backend.write(filename, bytes, null);
      exists = true;
      const snapshot = await backend.read(filename);
      expect(snapshot.bytes).toEqual(bytes);
      expect(snapshot.version).toBe(version);
      expect((await backend.readRange(filename, 1, 3)).bytes).toEqual(bytes.subarray(1, 4));
      const entry = await backend.lstat(filename);
      expect(entry.kind).toBe("file");
      await backend.copy(filename, copied, entry.revision, null);
      copyExists = true;
      expect((await backend.read(copied)).bytes).toEqual(bytes);
      expect((await backend.lstat(copied)).identity).not.toEqual(entry.identity);
      await expect(backend.copy(filename, copied, entry.revision, null)).rejects.toMatchObject({
        code: "CONFLICT",
        effect: "not-applied",
      });
      await backend.write(filename, Buffer.from("external"), snapshot.version);
      await expect(
        backend.write(filename, Buffer.from("stale"), snapshot.version),
      ).rejects.toMatchObject({ code: "CONFLICT", effect: "not-applied" });
      expect((await backend.read(filename)).bytes.toString()).toBe("external");
      const executed = await backend.execute(
        "python3",
        [
          "-c",
          "import os,sys; print(os.getcwd()); print(sys.argv[1]); sys.exit(7)",
          "literal ; $(false)",
        ],
        directory,
      );
      expect(executed.exitCode).toBe(7);
      expect(executed.stdout.toString()).toBe(`${directory}\nliteral ; $(false)\n`);
      const channel = await backend.startProcess(
        "python3",
        [
          "-c",
          "import sys; data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data); sys.exit(4)",
        ],
        directory,
      );
      const output: Buffer[] = [];
      channel.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      channel.stderr.resume();
      try {
        await channel.write(bytes);
        await channel.end();
        expect(await channel.completion).toEqual({ exitCode: 4 });
        expect(Buffer.concat(output)).toEqual(bytes);
      } finally {
        await channel.stop().catch(() => {});
      }
      const terminal = await backend.startProcess(
        "python3",
        ["-c", "import os,sys; print(sys.stdin.isatty()); print(os.get_terminal_size())"],
        directory,
        { pty: { cols: 82, rows: 27 } },
      );
      const terminalOutput: Buffer[] = [];
      terminal.stdout.on("data", (chunk: Buffer) => terminalOutput.push(chunk));
      terminal.stderr.resume();
      try {
        expect(await terminal.completion).toEqual({ exitCode: 0 });
        const rendered = Buffer.concat(terminalOutput).toString();
        expect(rendered).toContain("True\r\n");
        expect(rendered).toContain("columns=82, lines=27");
      } finally {
        await terminal.stop().catch(() => {});
      }
    } finally {
      if (copyExists) await backend.remove(copied, (await backend.read(copied)).version);
      if (exists) await backend.remove(filename, (await backend.read(filename)).version);
      const removed = await backend.execute("rmdir", ["--", directory], "/tmp");
      expect(removed.exitCode).toBe(0);
    }
  },
  60_000,
);
