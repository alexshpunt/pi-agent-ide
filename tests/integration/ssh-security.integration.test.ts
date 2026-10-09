import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { SshBackend, SshBackendError } from "#src/backend/ssh.js";
import { startSshFixture } from "./support/ssh-fixture.js";
import { startSshPrivateDiagnosticFixture } from "./support/ssh-private-diagnostic-fixture.js";

const run = promisify(execFile);

test("private OpenSSH Include files retain native configuration without enabling local commands or forwarding", async () => {
  const fixture = await startSshFixture();
  const occupied = net.createServer();
  try {
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("No owned local port");
    const directory = path.join(fixture.root, "included café");
    await mkdir(directory);
    const trusted = await readFile(fixture.config, "utf8");
    const marker = path.join(fixture.root, "forbidden-local-command");
    await writeFile(
      path.join(directory, "01-native.conf"),
      trusted.replace("  StrictHostKeyChecking yes", "  StrictHostKeyChecking no") +
        `  PermitLocalCommand yes\n  LocalCommand /usr/bin/touch ${marker}\n` +
        `  ForwardAgent yes\n  LocalForward 127.0.0.1:${address.port} 127.0.0.1:9\n  ExitOnForwardFailure yes\n`,
    );
    const config = path.join(fixture.root, "include_config");
    await writeFile(config, `Include "${directory}/*.conf"\n`);
    const backend = new SshBackend({
      id: "included",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: config,
    });
    const file = `${fixture.workspace}/note café #.txt`;
    const bytes = Buffer.from("Native café through Include\n");
    await backend.write(file, bytes, null);
    expect((await backend.read(file)).bytes).toEqual(bytes);
    const executed = await backend.execute(
      "python3",
      ["-c", "import os; print(os.getcwd()); print('SSH_AUTH_SOCK' in os.environ)"],
      fixture.workspace,
    );
    expect(executed).toMatchObject({ exitCode: 0 });
    expect(executed.stdout.toString("utf8")).toBe(`${fixture.workspace}\nFalse\n`);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    // Forwarding would fail on this still-owned occupied port if ClearAllForwardings were ignored.
    expect(occupied.listening).toBe(true);
  } finally {
    if (occupied.listening)
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    await fixture.stop();
  }
}, 20_000);

test("changed host keys and denied authentication refuse writes without exposing private configuration paths", async () => {
  const fixture = await startSshFixture();
  try {
    const trusted = await readFile(fixture.config, "utf8");
    const backend = new SshBackend({
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    });
    const file = `${fixture.workspace}/source.txt`;
    const original = Buffer.from("Preserved café source\n");
    const snapshot = await backend.write(file, original, null);
    const canary = "LPT149_PRIVATE_CREDENTIAL_PATH_CANARY";
    const config = path.join(fixture.root, canary);
    const knownHosts = path.join(fixture.root, "changed_known_hosts");
    const replacement = path.join(fixture.root, "replacement-host");
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", replacement]);
    const publicKey = (await readFile(`${replacement}.pub`, "utf8")).trim().split(" ");
    const host = (await readFile(path.join(fixture.root, "known_hosts"), "utf8")).split(" ")[0];
    await writeFile(knownHosts, `${host} ${publicKey[0]} ${publicKey[1]}\n`);
    const refused = new SshBackend({ ...backend.target, configFile: config });
    for (const code of ["HOST_KEY_FAILED", "AUTH_FAILED"] as const) {
      await writeFile(
        config,
        code === "HOST_KEY_FAILED"
          ? trusted
              .replace(/UserKnownHostsFile .*/u, `UserKnownHostsFile ${knownHosts}`)
              .replace(/StrictHostKeyChecking .*/u, "StrictHostKeyChecking no")
          : trusted.replace(/IdentityFile .*/u, `IdentityFile ${path.join(fixture.root, "host")}`),
      );
      let failure: unknown;
      try {
        await refused.write(file, Buffer.from("Must not be published\n"), snapshot);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SshBackendError);
      expect(failure).toMatchObject({ code, effect: "not-applied" });
      expect(String(failure)).not.toContain(canary);
      expect(JSON.stringify(failure)).not.toContain(canary);
      expect((await backend.read(file)).bytes).toEqual(original);
    }
  } finally {
    await fixture.stop();
  }
}, 20_000);

test("native OpenSSH proxy diagnostics are sanitized instead of becoming application output or error causes", async () => {
  const fixture = await startSshPrivateDiagnosticFixture();
  try {
    const canary = fixture.canary;
    const backend = new SshBackend(fixture.target);
    let failure: unknown;
    try {
      await backend.read(`${fixture.workspace}/not-contacted.txt`);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SshBackendError);
    expect(failure).toMatchObject({ code: "TRANSPORT_FAILED", effect: "not-applied" });
    expect(String(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain("Sensitive transport diagnostic");
  } finally {
    await fixture.stop();
  }
}, 15_000);
