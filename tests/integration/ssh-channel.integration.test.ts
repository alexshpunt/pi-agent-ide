import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { SshBackend } from "#src/backend/ssh.js";
import { startSshProcess } from "#src/backend/ssh-channel.js";
import { startSshFixture, type SshFixture } from "#integration/support/ssh-fixture.js";

let fixture: SshFixture;
let backend: SshBackend;
beforeAll(async () => {
  fixture = await startSshFixture();
  backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
});
afterAll(async () => {
  await fixture.stop();
});

test("SSH service channel keeps binary streams separate and program exit 255 distinct from transport loss", async () => {
  const channel = await startSshProcess(
    backend.target,
    "python3",
    [
      "-c",
      "import os,sys; os.write(2, (os.getcwd()+'\\n'+sys.argv[1]+'\\n').encode());\nwhile True:\n data=os.read(0,4096)\n if not data: break\n os.write(1,data)\nsys.exit(255)",
      "literal ; $(false)",
    ],
    fixture.workspace,
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  channel.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  channel.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  try {
    const bytes = Buffer.alloc(200_000);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
    await channel.write(bytes);
    await channel.end();
    expect(await channel.completion).toEqual({ exitCode: 255 });
    expect(Buffer.concat(stdout)).toEqual(bytes);
    expect(Buffer.concat(stderr).toString()).toBe(`${fixture.workspace}\nliteral ; $(false)\n`);
    await expect(channel.write(Buffer.from("late"))).rejects.toMatchObject({
      code: "INPUT_CLOSED",
    });
  } finally {
    await channel.stop().catch(() => {});
  }
});

test("SSH service channel can be stopped while stdin is blocked", async () => {
  const channel = await startSshProcess(
    backend.target,
    "python3",
    ["-c", "import time; time.sleep(120)"],
    fixture.workspace,
  );
  channel.stdout.resume();
  channel.stderr.resume();
  const input = channel.write(Buffer.alloc(200_000));
  // Retain the rejection handler while stop cancels an outstanding input acknowledgement.
  const inputResult = input.catch((error: unknown) => error);
  expect(
    await Promise.race([
      input.then(() => "accepted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]),
  ).toBe("blocked");
  const result = await channel.stop();
  expect(result.exitCode).toBeLessThan(0);
  expect(await inputResult).toMatchObject({ code: "INPUT_CLOSED" });
});

test("SSH channel streams beyond snapshot limits without collecting the whole output", async () => {
  const channel = await startSshProcess(
    backend.target,
    "python3",
    ["-c", "import os; chunk=b'x'*16384;\nfor _ in range(2100): os.write(1,chunk)"],
    fixture.workspace,
  );
  let length = 0;
  channel.stdout.on("data", (chunk: Buffer) => {
    length += chunk.length;
  });
  channel.stderr.resume();
  try {
    expect(await channel.completion).toEqual({ exitCode: 0 });
    expect(length).toBe(2100 * 16384);
  } finally {
    await channel.stop().catch(() => {});
  }
}, 30_000);

test("SSH channel abort escalates and reaps a service that ignores SIGTERM", async () => {
  const controller = new AbortController();
  const channel = await startSshProcess(
    backend.target,
    "python3",
    [
      "-c",
      "import os,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print(os.getpid(),flush=True); time.sleep(120)",
    ],
    fixture.workspace,
    { signal: controller.signal },
  );
  channel.stderr.resume();
  const pid = await new Promise<number>((resolve) => {
    let text = "";
    channel.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\n")) resolve(Number(text.trim()));
    });
  });
  try {
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(channel.pid).toBe(pid);
    expect(channel.source).toBe(`ssh://fixture${fixture.workspace}`);
    controller.abort();
    await expect(channel.completion).rejects.toMatchObject({
      code: "CANCELLED",
      name: "AbortError",
      effect: "unknown",
    });
    expect(() => process.kill(pid, 0)).toThrow("ESRCH");
    // Cancellation remains an operation failure, but cleanup retains the actual exit report.
    await expect(channel.stop()).resolves.toEqual({ exitCode: -9 });
  } finally {
    await channel.stop().catch(() => {});
  }
}, 15_000);

test("SSH PTY channels expose a controlling terminal and apply remote resize before input", async () => {
  const channel = await startSshProcess(
    backend.target,
    "python3",
    [
      "-c",
      "import os,sys; print(sys.stdin.isatty(),flush=True); line=input(); print(os.get_terminal_size(),flush=True); print(line,flush=True)",
    ],
    fixture.workspace,
    { pty: { cols: 80, rows: 24 } },
  );
  const output: Buffer[] = [];
  const firstOutput = new Promise<string>((resolve) => {
    channel.stdout.on("data", (chunk: Buffer) => {
      output.push(chunk);
      resolve(Buffer.concat(output).toString());
    });
  });
  channel.stderr.resume();
  try {
    expect(await firstOutput).toContain("True");
    await channel.resize(100, 35);
    await expect(channel.end()).rejects.toMatchObject({
      code: "PTY_INPUT_NOT_CLOSABLE",
      effect: "not-applied",
    });
    await channel.write(Buffer.from("hello terminal\n"));
    expect(await channel.completion).toEqual({ exitCode: 0 });
    const rendered = Buffer.concat(output).toString();
    expect(rendered).toContain("columns=100, lines=35");
    expect(rendered).toContain("hello terminal\r\n");
  } finally {
    await channel.stop().catch(() => {});
  }
});

test("SSH PTY control bytes interrupt the foreground process instead of becoming text input", async () => {
  const channel = await startSshProcess(
    backend.target,
    "python3",
    ["-c", "import os,time; print(os.tcgetpgrp(0)==os.getpgrp(),flush=True); time.sleep(120)"],
    fixture.workspace,
    { pty: { cols: 80, rows: 24 } },
  );
  const firstOutput = new Promise<string>((resolve) => {
    channel.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()));
  });
  channel.stderr.resume();
  try {
    expect(await firstOutput).toContain("True");
    channel.stdout.resume();
    await channel.write(Buffer.from([3]));
    expect((await channel.completion).exitCode).not.toBe(0);
  } finally {
    await channel.stop().catch(() => {});
  }
});

test("closing an output consumer still drains authoritative SSH process completion", async () => {
  const channel = await startSshProcess(
    backend.target,
    "python3",
    [
      "-c",
      "import os,sys; os.read(0,1); os.write(1,b'x'*200000); os.write(2,b'y'*200000); sys.exit(7)",
    ],
    fixture.workspace,
  );
  const outputReady = new Promise<void>((resolve) => {
    channel.stdout.once("readable", resolve);
  });
  try {
    const input = channel.write(Buffer.from("x"));
    void input.catch(() => {});
    await outputReady;
    channel.stdout.destroy();
    channel.stderr.destroy();
    // The child must finish and its actual exit frame must arrive even without a reader.
    const timeout = AbortSignal.timeout(7000);
    await Promise.race([
      channel.completion.then((result) => {
        expect(result).toEqual({ exitCode: 7 });
      }),
      new Promise<void>((_resolve, reject) => {
        timeout.addEventListener(
          "abort",
          () => reject(new Error("Process completion was blocked")),
          { once: true },
        );
      }),
    ]);
  } finally {
    await channel.stop().catch(() => {});
  }
}, 15000);

test("cancelled cleanup refuses a missing native exit frame even when SSH closes cleanly", async () => {
  const owned = await startSshFixture({
    python3: path.resolve("tests/integration/fixtures/ssh-channel-drop-exit.py"),
  });
  const controller = new AbortController();
  const channel = await startSshProcess(
    {
      id: "drop-exit",
      host: "fixture",
      workspace: owned.workspace,
      configFile: owned.config,
    },
    "/usr/bin/python3",
    ["-c", "import os,time; print(os.getpid(),flush=True); time.sleep(120)"],
    owned.workspace,
    { signal: controller.signal },
  );
  channel.stderr.resume();
  try {
    await new Promise<void>((resolve) => {
      channel.stdout.once("data", () => resolve());
    });
    channel.stdout.resume();
    controller.abort();
    await expect(channel.completion).rejects.toMatchObject({
      code: "CANCELLED",
      effect: "unknown",
    });
    await expect(channel.stop()).rejects.toMatchObject({ code: "CANCELLED", effect: "unknown" });
    expect(() => process.kill(channel.pid, 0)).toThrow("ESRCH");
  } finally {
    await channel.stop().catch(() => {});
    await owned.stop();
  }
}, 15_000);

test("SSH channel startup failures are sanitized and no command is claimed started", async () => {
  await expect(
    startSshProcess(backend.target, "missing-program-ssh-channel", [], fixture.workspace),
  ).rejects.toMatchObject({ code: "ENOENT", effect: "not-applied" });
});
