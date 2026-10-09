import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { SshBackend } from "#src/backend/ssh.js";
import { startSshProcess } from "#src/backend/ssh-channel.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";

const run = promisify(execFile);

test("IDE channels never forward a provisioned private agent even when target configuration requests it", async () => {
  const fixture = await startSshFixture({}, {}, undefined, { agentForwarding: true });
  const socket = path.join(fixture.root, "owned-agent.socket");
  let agent: ChildProcess | undefined;
  try {
    agent = spawn("ssh-agent", ["-D", "-a", socket], { stdio: "ignore" });
    await expect
      .poll(async () => (await stat(socket).catch(() => undefined))?.isSocket())
      .toBe(true);
    const env = { ...process.env, SSH_AUTH_SOCK: socket };
    // Only this fixture's generated key is loaded; no user agent or key is accessed.
    await run("ssh-add", [path.join(fixture.root, "client")], { env });
    const config = path.join(fixture.root, "agent_config");
    await writeFile(
      config,
      (await readFile(fixture.config, "utf8")) +
        `  IdentityAgent ${socket}\n  ForwardAgent ${socket}\n`,
    );
    // The server and private agent really permit forwarding; absence below is a client restriction.
    const control = await run(
      "ssh",
      ["-F", config, "fixture", "ssh-add -l >/dev/null 2>&1 && printf 'agent-present\\n'"],
      { env },
    );
    expect(control.stdout).toBe("agent-present\n");
    const backend = new SshBackend({
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: config,
    });
    const probe =
      "import os,subprocess; print('SSH_AUTH_SOCK' in os.environ); print(subprocess.run(['ssh-add','-l'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode)";
    const result = await backend.execute("python3", ["-c", probe], fixture.workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("False\n2\n");
    const channel = await startSshProcess(
      backend.target,
      "python3",
      ["-c", probe],
      fixture.workspace,
      { pty: { cols: 80, rows: 24 } },
    );
    const output: Buffer[] = [];
    channel.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    channel.stderr.resume();
    try {
      expect(await channel.completion).toEqual({ exitCode: 0 });
      expect(Buffer.concat(output).toString("utf8").replaceAll("\r", "")).toBe("False\n2\n");
    } finally {
      await channel.stop();
    }
    const file = path.join(fixture.workspace, "agent-safe.txt");
    const bytes = Buffer.from("Requested café with private agent available\n");
    await backend.write(file, bytes, null);
    expect((await backend.read(file)).bytes).toEqual(bytes);
    // The fixture agent remains available, rather than being disabled to satisfy the negative check.
    expect(
      (
        await run(
          "ssh",
          ["-F", config, "fixture", "ssh-add -l >/dev/null 2>&1 && printf 'agent-present\\n'"],
          { env },
        )
      ).stdout,
    ).toBe("agent-present\n");
  } finally {
    try {
      if (agent && agent.exitCode === null && agent.signalCode === null) {
        const stopped = once(agent, "exit");
        agent.kill("SIGTERM");
        await stopped;
      }
      if (agent?.pid)
        await expect(stat(`/proc/${agent.pid}`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.stop();
    }
    await expect(stat(fixture.root)).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 30_000);
