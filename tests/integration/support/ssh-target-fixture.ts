import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import type { SshTarget } from "#src/backend/ssh.ts";
import { startSshFixture } from "./ssh-fixture.ts";

/** The operating system family of the machine running Pi, or of the SSH server it reaches. */
export type Platform = "linux" | "windows";
export type Direction = `${Platform}>${Platform}`;
export const directions: readonly Direction[] = [
  "linux>linux",
  "linux>windows",
  "windows>linux",
  "windows>windows",
];

/** Pi's own machine. A Linux Pi inside WSL on a Windows host is still a Linux source. */
export const sourcePlatform: Platform = process.platform === "win32" ? "windows" : "linux";

/**
 * Directions to run, written `source>target`. CI names them explicitly, so a direction whose
 * fixture cannot start fails instead of being skipped. Without the variable, the directions this
 * machine can serve run: Windows targets need a Windows source, WSL interop, or a trusted
 * Windows host named by PI_SSH_COVERAGE_WINDOWS_HOST.
 */
export function selectedDirections(): readonly Direction[] {
  const requested = process.env.PI_SSH_COVERAGE_DIRECTIONS;
  if (!requested)
    return directions.filter(
      (direction) =>
        direction.startsWith(sourcePlatform) &&
        (direction !== "linux>windows" ||
          Boolean(process.env.WSL_DISTRO_NAME || process.env.PI_SSH_COVERAGE_WINDOWS_HOST)),
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

/** One disposable SSH server reached from this process, with out-of-band file access to its workspace. */
export interface SshTargetFixture {
  readonly source: Platform;
  readonly os: Platform;
  /** Backend target using only fixture-owned keys and host configuration. */
  readonly target: SshTarget;
  /** Canonical backend path of the workspace, such as `/tmp/x` or `/C:/Users/x`. */
  readonly workspace: string;
  /** Canonical backend path of a workspace-relative path. */
  canonical(relative: string): string;
  put(relative: string, bytes: Uint8Array | string): Promise<void>;
  get(relative: string): Promise<Buffer>;
  stop(): Promise<void>;
}

interface RunOptions {
  readonly input?: Uint8Array | string;
  readonly cwd?: string;
}

function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      // Like the SSH channel: Windows OpenSSH can block on synchronous pipes outside a desktop.
      stdio: "overlapped",
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(stdout))
        : reject(
            new Error(
              `${command} ${args.join(" ")} exited with ${code}: ${Buffer.concat(stderr).toString()}`,
            ),
          ),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}

async function text(command: string, args: readonly string[], options?: RunOptions) {
  return (await run(command, args, options)).toString("utf8").trim();
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

/** Remote Python reaches both shells through the same shell-neutral first line. */
function remote(target: Platform, source: string, input: Uint8Array | string = "") {
  const interpreter = target === "windows" ? "py -3" : "python3";
  const loader = `exec(__import__('base64').b64decode('${Buffer.from(source).toString("base64")}'))\n`;
  return {
    command: `${interpreter} -c "import sys;exec(sys.stdin.buffer.raw.readline())"`,
    input: Buffer.concat([Buffer.from(loader), Buffer.from(input)]),
  };
}

/** OpenSSH arguments that reach a fixture server through its private client config. */
const fixtureDestination = (config: string): readonly string[] => ["-F", config, "fixture"];

function sshAccess(
  destination: readonly string[],
  target: Platform,
  nativeRoot: string,
): Pick<SshTargetFixture, "put" | "get"> {
  const join = (relative: string) => `${nativeRoot}/${relative}`;
  const execute = async (source: string, input?: Uint8Array | string) => {
    const program = remote(target, source, input);
    return run("ssh", [...destination, program.command], { input: program.input });
  };
  return {
    async put(relative, bytes) {
      await execute(
        `import os,sys\np=${JSON.stringify(join(relative))}\nos.makedirs(os.path.dirname(p),exist_ok=True)\nopen(p,'wb').write(sys.stdin.buffer.read())`,
        bytes,
      );
    },
    get(relative) {
      return execute(
        `import sys\nsys.stdout.buffer.write(open(${JSON.stringify(join(relative))},'rb').read())`,
      );
    },
  };
}

async function keygen(command: string, file: string): Promise<void> {
  await run(command, ["-q", "-t", "ed25519", "-N", "", "-f", file]);
}

/** Write a client config whose only trust is the fixture host key. */
async function clientConfig(options: {
  readonly directory: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly hostPublic: string;
  readonly identity: string;
}): Promise<string> {
  const slash = (value: string) => value.replaceAll("\\", "/");
  const [type, key] = options.hostPublic.trim().split(" ");
  const knownHosts = path.join(options.directory, "known_hosts");
  await writeFile(knownHosts, `[${options.host}]:${options.port} ${type} ${key}\n`);
  const config = path.join(options.directory, "ssh_config");
  await writeFile(
    config,
    [
      "Host fixture",
      `  HostName ${options.host}`,
      `  Port ${options.port}`,
      `  User ${options.user}`,
      `  IdentityFile ${slash(options.identity)}`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${slash(knownHosts)}`,
      `  GlobalKnownHostsFile ${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "  StrictHostKeyChecking yes",
      "  BatchMode yes",
      "  ControlMaster no",
      "",
    ].join("\n"),
  );
  return config;
}

async function waitForServer(config: string, server: ChildProcess, logs: () => string) {
  let lastError: unknown;
  server.on("error", (error) => (lastError = error));
  for (let attempt = 0; attempt < 150 && server.exitCode === null; attempt++) {
    try {
      await run("ssh", ["-F", config, "-o", "ConnectTimeout=3", "fixture", "exit 0"]);
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Fixture sshd did not become usable: ${logs()}`, { cause: lastError });
}

function collect(child: ChildProcess): () => string {
  let logs = "";
  child.stderr?.on("data", (chunk: Buffer) => (logs += chunk.toString()));
  child.stdout?.on("data", (chunk: Buffer) => (logs += chunk.toString()));
  return () => logs.slice(-2000);
}

async function privateDirectory(): Promise<string> {
  const parent = path.join(os.tmpdir(), ".tmp");
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, "pi-ide-ssh-"));
}

/** Start the target of one direction, or fail setup; a missing capability is never a skip. */
export async function startTargetFixture(targetOs: Platform): Promise<SshTargetFixture> {
  const windowsHost = process.env.PI_SSH_COVERAGE_WINDOWS_HOST;
  if (targetOs === "windows" && windowsHost) return startExistingWindowsTarget(windowsHost);
  if (sourcePlatform === "linux" && targetOs === "linux") return startLinuxFromLinux();
  if (sourcePlatform === "windows" && targetOs === "linux") return startLinuxFromWindows();
  return startWindowsTarget();
}

async function startLinuxFromLinux(): Promise<SshTargetFixture> {
  const fixture = await startSshFixture();
  return {
    source: "linux",
    os: "linux",
    target: {
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    },
    workspace: fixture.workspace,
    canonical: (relative) => `${fixture.workspace}/${relative}`,
    ...sshAccess(fixtureDestination(fixture.config), "linux", fixture.workspace),
    stop: () => fixture.stop(),
  };
}

/**
 * A trusted Windows host from the user's OpenSSH config, for directions this machine cannot start
 * a Windows server for. The workspace is a new temporary directory that stop() removes.
 */
async function startExistingWindowsTarget(host: string): Promise<SshTargetFixture> {
  const destination = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", host];
  const python = async (source: string) => {
    const program = remote("windows", source);
    return (await run("ssh", [...destination, program.command], { input: program.input }))
      .toString("utf8")
      .trim();
  };
  const native = (
    await python("import tempfile\nprint(tempfile.mkdtemp(prefix='pi-ide-ssh-'), end='')")
  ).replaceAll("\\", "/");
  const workspace = `/${native.replace(/^([a-z]):/iu, (_match, drive: string) => `${drive.toUpperCase()}:`)}`;
  return {
    source: sourcePlatform,
    os: "windows",
    target: { id: "fixture", host, workspace, os: "windows" },
    workspace,
    canonical: (relative) => `${workspace}/${relative}`,
    ...sshAccess(destination, "windows", native),
    stop: async () => {
      await python(`import shutil\nshutil.rmtree(${JSON.stringify(native)}, ignore_errors=True)`);
    },
  };
}

/** A sshd inside WSL, started from Windows through wsl.exe and reached on localhost. */
async function startLinuxFromWindows(): Promise<SshTargetFixture> {
  const distribution = process.env.PI_SSH_WSL_DISTRO;
  const wsl = (args: readonly string[], options?: RunOptions) =>
    run(
      "wsl.exe",
      [...(distribution ? ["-d", distribution] : []), "-u", "root", "--exec", ...args],
      options,
    );
  const wslText = async (args: readonly string[], options?: RunOptions) =>
    (await wsl(args, options)).toString("utf8").trim();
  const local = await privateDirectory();
  let root: string | undefined;
  let server: ChildProcess | undefined;
  const cleanup = async () => {
    if (root) {
      const pid = await wslText(["cat", `${root}/sshd.pid`]).catch(() => "");
      if (/^\d+$/u.test(pid)) await wsl(["kill", pid]).catch(() => undefined);
      await wsl(["rm", "-rf", root]).catch(() => undefined);
    }
    if (server && server.exitCode === null) server.kill();
    await rm(local, { recursive: true, force: true });
  };
  try {
    if ((await wslText(["id", "-u", "agent"]).catch(() => "")) === "")
      throw new Error("The WSL account 'agent' is missing; create it before running this fixture");
    root = await wslText(["mktemp", "-d", "/tmp/pi-ide-ssh-XXXXXX"]);
    await wsl(["chmod", "755", root]);
    const workspace = `${root}/workspace`;
    await wsl(["mkdir", workspace]);
    await wsl(["chown", "agent", workspace]);
    await wsl(["mkdir", "-p", "/run/sshd"]);
    await wsl(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", `${root}/host`]);
    const identity = path.join(local, "client");
    await keygen("ssh-keygen", identity);
    await wsl(["tee", `${root}/authorized_keys`], { input: await readFile(`${identity}.pub`) });
    await wsl(["chmod", "644", `${root}/authorized_keys`]);
    const port = await unusedPort();
    await wsl(["tee", `${root}/sshd_config`], {
      input: [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${root}/host`,
        `PidFile ${root}/sshd.pid`,
        `AuthorizedKeysFile ${root}/authorized_keys`,
        "AllowUsers agent",
        "StrictModes no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM yes",
        "PermitRootLogin no",
        "LogLevel ERROR",
        "",
      ].join("\n"),
    });
    const config = await clientConfig({
      directory: local,
      host: "127.0.0.1",
      port,
      user: "agent",
      hostPublic: await wslText(["cat", `${root}/host.pub`]),
      identity,
    });
    server = spawn(
      "wsl.exe",
      [
        ...(distribution ? ["-d", distribution] : []),
        "-u",
        "root",
        "--exec",
        "/usr/sbin/sshd",
        "-D",
        "-e",
        "-f",
        `${root}/sshd_config`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    await waitForServer(config, server, collect(server));
    return {
      source: "windows",
      os: "linux",
      target: { id: "fixture", host: "fixture", workspace, configFile: config },
      workspace,
      canonical: (relative) => `${workspace}/${relative}`,
      ...sshAccess(fixtureDestination(config), "linux", workspace),
      stop: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * The Windows OpenSSH server as the disposable process `sshd.exe -D -f <private config>`.
 * A Windows source reaches it on localhost. A Linux source in WSL starts it through interop and
 * reaches it at the Windows address of the WSL network, behind a port-scoped firewall rule.
 */
async function startWindowsTarget(): Promise<SshTargetFixture> {
  const fromLinux = sourcePlatform === "linux";
  const openssh = fromLinux
    ? "/mnt/c/Windows/System32/OpenSSH"
    : path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH");
  const sshd = path.join(openssh, "sshd.exe");
  const windowsKeygen = path.join(openssh, "ssh-keygen.exe");
  const powershell = (script: string) =>
    text(fromLinux ? "powershell.exe" : "powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
  const toLocal = (windows: string) => (fromLinux ? text("wslpath", ["-u", windows]) : windows);
  const local = await privateDirectory();
  let server: ChildProcess | undefined;
  let serverDirectory: string | undefined;
  let rule: string | undefined;
  let sshdPid: string | undefined;
  const cleanup = async () => {
    if (fromLinux && sshdPid)
      await run(path.join("/mnt/c/Windows/System32", "taskkill.exe"), [
        "/F",
        "/PID",
        sshdPid,
      ]).catch(() => undefined);
    if (server && server.exitCode === null) server.kill();
    if (rule)
      await powershell(`Remove-NetFirewallRule -DisplayName '${rule}'`).catch(() => undefined);
    for (const directory of [serverDirectory, local])
      if (directory)
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  try {
    const [windowsTemp = "", user = ""] = (
      await powershell("[IO.Path]::GetTempPath(); $env:USERNAME")
    )
      .split(/\r?\n/u)
      .map((line) => line.trim());
    if (!windowsTemp || !user) throw new Error("Cannot determine the Windows temporary directory");
    const suffix = randomBytes(6).toString("hex");
    const windowsDirectory = fromLinux
      ? `${windowsTemp.replace(/[\\/]+$/u, "")}\\pi-ide-ssh-${suffix}`
      : path.join(windowsTemp, `pi-ide-ssh-${suffix}`);
    serverDirectory = await toLocal(windowsDirectory);
    await mkdir(path.join(serverDirectory, "workspace"), { recursive: true });
    const forward = (value: string) => value.replaceAll("\\", "/");
    await run(windowsKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", `${windowsDirectory}\\host`]);
    const identity = path.join(local, "client");
    await keygen("ssh-keygen", identity);
    await writeFile(
      path.join(serverDirectory, "authorized_keys"),
      await readFile(`${identity}.pub`),
    );
    const port = await unusedPort();
    const address = fromLinux
      ? (await text("ip", ["route", "show", "default"])).split(/\s+/u)[2]
      : "127.0.0.1";
    if (!address) throw new Error("Cannot determine the Windows address of the WSL network");
    await writeFile(
      path.join(serverDirectory, "sshd_config"),
      [
        `Port ${port}`,
        `ListenAddress ${address}`,
        `HostKey ${forward(windowsDirectory)}/host`,
        `PidFile ${forward(windowsDirectory)}/sshd.pid`,
        `AuthorizedKeysFile ${forward(windowsDirectory)}/authorized_keys`,
        "StrictModes no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "LogLevel ERROR",
        "",
      ].join("\n"),
    );
    if (fromLinux) {
      rule = `pi-ide-ssh-fixture-${suffix}`;
      await powershell(
        `New-NetFirewallRule -DisplayName '${rule}' -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Any | Out-Null`,
      );
    }
    server = spawn(sshd, ["-D", "-e", "-f", `${windowsDirectory}\\sshd_config`], {
      // sshd re-executes itself and needs a Windows absolute path as argv[0], also through WSL interop.
      argv0: fromLinux ? "C:\\Windows\\System32\\OpenSSH\\sshd.exe" : sshd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const logs = collect(server);
    const config = await clientConfig({
      directory: local,
      host: address,
      port,
      user,
      hostPublic: await readFile(path.join(serverDirectory, "host.pub"), "utf8"),
      identity,
    });
    await waitForServer(config, server, logs);
    sshdPid = (await readFile(path.join(serverDirectory, "sshd.pid"), "utf8")).trim();
    const native = `${forward(windowsDirectory)}/workspace`;
    const workspace = `/${native.replace(/^([a-z]):/u, (_match, drive: string) => `${drive.toUpperCase()}:`)}`;
    return {
      source: sourcePlatform,
      os: "windows",
      target: { id: "fixture", host: "fixture", workspace, configFile: config, os: "windows" },
      workspace,
      canonical: (relative) => `${workspace}/${relative}`,
      ...sshAccess(fixtureDestination(config), "windows", native),
      stop: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
