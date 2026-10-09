import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// EOF stops the private listener even when the test owner exits before its finally block.
const fixtureServer = String.raw`
import ctypes,os,select,shutil,signal,subprocess,sys
stopping=False
parent=os.getpid()
def child_guard():
 if ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)!=0: raise OSError('No fixture parent-death guard')
 if os.getppid()!=parent: os._exit(1)
def stop(_signal,_frame):
 global stopping
 stopping=True
signal.signal(signal.SIGTERM,stop)
server=subprocess.Popen(['/usr/sbin/sshd','-D','-e','-f',sys.argv[1]],preexec_fn=child_guard)
try:
 while not stopping and server.poll() is None:
  ready,_,_=select.select([sys.stdin],[],[],0.1)
  if ready and sys.stdin.readline() in ('','stop\n'): break
finally:
 if server.poll() is None: server.terminate()
 server.wait()
 shutil.rmtree(sys.argv[2],ignore_errors=True)
`;

/** Disposable loopback SSH server; remote commands use an existing unprivileged account. */
export interface SshFixture {
  readonly root: string;
  readonly workspace: string;
  readonly config: string;
  /** Controller PID of this fixture's owned SSH or namespace supervisor handle. */
  readonly serverPid: number;
  stop(): Promise<void>;
}

/** Create only fixture-owned keys, host configuration and workspace, never user SSH files.
 * Environment values may use {workspace} to point at private generated configuration.
 * A network fixture may supply a private namespace supervisor and Unix-socket SSH proxy.
 * Agent forwarding is denied unless a security fixture explicitly enables it.
 */
export async function startSshFixture(
  tools: Readonly<Record<string, string>> = {},
  environment: Readonly<Record<string, string>> = {},
  network?: { readonly server: string; readonly proxy: string; readonly pidNamespace?: boolean },
  policy: { readonly agentForwarding?: boolean } = {},
): Promise<SshFixture> {
  const parent = path.join(os.tmpdir(), ".tmp");
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const root = await mkdtemp(path.join(parent, "pi-ide-ssh-"));
  let server: ChildProcess | undefined;
  async function stopServer(): Promise<void> {
    if (
      !server ||
      server.pid === undefined ||
      server.exitCode !== null ||
      server.signalCode !== null
    )
      return;
    const stopped = once(server, "exit");
    if (!network || network.pidNamespace) {
      if (!server.stdin) throw new Error("Namespace supervisor has no control pipe");
      server.stdin.end("stop\n");
    } else server.kill("SIGTERM");
    await stopped;
  }
  try {
    await chmod(root, 0o755);
    const account = process.getuid?.() === 0 ? "agent" : os.userInfo().username;
    const uid = Number((await run("id", ["-u", account])).stdout.trim());
    const gid = Number((await run("id", ["-g", account])).stdout.trim());
    if (uid === 0)
      throw new Error("SSH fixture must execute remote commands as an unprivileged user");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { mode: 0o755 });
    if (process.getuid?.() === 0) await chown(workspace, uid, gid);
    for (const key of ["host", "client"])
      await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(root, key)]);
    const toolsDirectory = path.join(root, "bin");
    await mkdir(toolsDirectory, { mode: 0o755 });
    for (const [name, source] of Object.entries(tools)) {
      if (!/^[a-zA-Z0-9_-]+$/u.test(name)) throw new Error("Invalid fixture tool name");
      const destination = path.join(toolsDirectory, name);
      await copyFile(source, destination);
      await chmod(destination, 0o755);
    }
    const authorized = path.join(root, "authorized_keys");
    await writeFile(authorized, await readFile(path.join(root, "client.pub")), { mode: 0o644 });
    const port = await unusedPort();
    const hostPublic = (await readFile(path.join(root, "host.pub"), "utf8")).trim().split(" ");
    await writeFile(
      path.join(root, "known_hosts"),
      `[127.0.0.1]:${port} ${hostPublic[0]} ${hostPublic[1]}\n`,
    );
    const serverConfig = path.join(root, "sshd_config");
    await writeFile(
      serverConfig,
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${path.join(root, "host")}`,
        `PidFile ${path.join(root, "sshd.pid")}`,
        `AuthorizedKeysFile ${authorized}`,
        `AllowUsers ${account}`,
        "StrictModes no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM yes",
        "PermitRootLogin no",
        `AllowAgentForwarding ${policy.agentForwarding ? "yes" : "no"}`,
        "X11Forwarding no",
        "LogLevel ERROR",
        `SetEnv PATH=${toolsDirectory}:/usr/local/bin:/usr/bin:/bin ${Object.entries(environment)
          .map(([key, template]) => {
            const value = template.replaceAll("{workspace}", workspace);
            if (
              !/^[A-Za-z_][A-Za-z\d_]*$/u.test(key) ||
              /[\s"'\\\0]/u.test(value) ||
              key === "PATH"
            )
              throw new TypeError("Invalid fixture environment");
            return `${key}=${value}`;
          })
          .join(" ")}`,
        "",
      ].join("\n"),
    );
    const config = path.join(root, "ssh_config");
    await writeFile(
      config,
      [
        "Host fixture",
        "  HostName 127.0.0.1",
        `  Port ${port}`,
        `  User ${account}`,
        `  IdentityFile ${path.join(root, "client")}`,
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ${path.join(root, "known_hosts")}`,
        "  GlobalKnownHostsFile /dev/null",
        "  StrictHostKeyChecking yes",
        "  BatchMode yes",
        "  ControlMaster no",
        ...(network
          ? [
              `  ProxyCommand /usr/bin/python3 ${quote(network.proxy)} ${quote(path.join(root, "ssh.socket"))}`,
            ]
          : []),
        "",
      ].join("\n"),
    );
    server = network
      ? spawn(
          "unshare",
          [
            ...(network.pidNamespace ? ["--pid", "--fork", "--mount-proc", "--kill-child"] : []),
            "--net",
            "/usr/bin/python3",
            network.server,
            serverConfig,
            path.join(root, "ssh.socket"),
            workspace,
          ],
          { stdio: "pipe" },
        )
      : spawn("/usr/bin/python3", ["-c", fixtureServer, serverConfig, root], { stdio: "pipe" });
    let logs = "";
    server.stderr?.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
    });
    const startError = new Promise<never>((_resolve, reject) => {
      server?.once("error", reject);
      server?.once("exit", () => reject(new Error(`Fixture sshd exited: ${logs}`)));
    });
    await Promise.race([waitForServer(config), startError]);
    const serverPid = server.pid;
    if (serverPid === undefined) throw new Error("Fixture supervisor has no PID");
    return {
      root,
      workspace,
      config,
      serverPid,
      async stop() {
        await stopServer();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stopServer();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
async function unusedPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForServer(config: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await run("ssh", ["-F", config, "-o", "ConnectTimeout=1", "fixture", "true"]);
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Fixture sshd did not become usable", { cause: lastError });
}
