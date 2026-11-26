import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { sshArguments, type SshTarget } from "./remote.ts";

const exec = promisify(execFile);

export type InstallInspection = {
  state: "found" | "missing" | "invalid" | "unsupported";
  platform: string;
  executable?: string;
  destination?: string;
  detail?: string;
};

const manualInstall = "https://docs.unity.com/en-us/unity-cli/use-unity-cli";
const unsupportedDetail = `Automatic installation is not supported on this platform. Install manually: ${manualInstall}`;

/** Where Unity's official installers are downloaded from; PI_UNITY_INSTALLER_BASE overrides it, for example for a mirror. */
export const installerBase = () =>
  (process.env.PI_UNITY_INSTALLER_BASE || "https://unity.com/").replace(/\/?$/, "/");

/** Host facts read by local inspection; tests replace them to simulate another platform. */
export const hostProbe = {
  platform: (): string => process.platform,
  arch: (): string => process.arch,
  osrelease: async (): Promise<string> => {
    try {
      return await readFile("/proc/sys/kernel/osrelease", "utf8");
    } catch {
      return "";
    }
  },
};

type LocalHost = { os: "linux" | "darwin" | "windows" | "wsl"; arch: "x64" | "arm64" } | undefined;

async function detectHost(): Promise<LocalHost> {
  const arch =
    hostProbe.arch() === "x64" ? "x64" : hostProbe.arch() === "arm64" ? "arm64" : undefined;
  if (!arch) return undefined;
  switch (hostProbe.platform()) {
    case "win32": {
      return { os: "windows", arch };
    }
    case "darwin": {
      return { os: "darwin", arch };
    }
    case "linux": {
      return {
        os: (await hostProbe.osrelease()).toLowerCase().includes("microsoft") ? "wsl" : "linux",
        arch,
      };
    }
    default: {
      return undefined;
    }
  }
}

// Run the same fixed probe on a selected SSH host. JSON is an argument, never shell code.
// An SSH or Python failure stays a transport error, not a missing installation.
const program = String.raw`
import json, os, platform, shutil, subprocess, sys, tempfile, urllib.request
request = json.loads(sys.argv[1])
home = os.path.expanduser('~')
destination = os.path.join(home, '.local', 'share', 'pi-agent-unity', 'bin', 'unity')
platform_name = platform.system().lower() + '-' + platform.machine().lower()
manual = 'https://docs.unity.com/en-us/unity-cli/use-unity-cli'
def is_wsl():
    try:
        with open('/proc/sys/kernel/osrelease') as f:
            return 'microsoft' in f.read().lower()
    except OSError:
        return False
def powershell():
    root = os.environ.get('SystemRoot', 'C:' + chr(92) + 'Windows')
    return shutil.which('powershell.exe') or subprocess.check_output(['wslpath', '-u', root + chr(92) + chr(92).join(['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'])], text=True, timeout=5).strip()
def ps_output(ps, command):
    return subprocess.check_output([ps, '-NoProfile', '-NonInteractive', '-Command', command], text=True, timeout=20, stdin=subprocess.DEVNULL).strip()
def fetch(name):
    with urllib.request.urlopen(request['base'] + name, timeout=30) as response:
        content = response.read(1048577)
    if len(content) > 1048576:
        raise RuntimeError('Installer exceeds the expected size.')
    return content
def inspect():
    explicit = request.get('explicit')
    candidates = [explicit] if explicit else ['unity', destination, os.path.join(home, '.local', 'bin', 'unity'), os.path.join(home, '.unity', 'bin', 'unity')]
    if not explicit and platform.system() == 'Windows' and os.environ.get('LOCALAPPDATA'):
        candidates.append(os.path.join(os.environ['LOCALAPPDATA'], 'Unity', 'bin', 'unity.exe'))
    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            try:
                subprocess.run([resolved, '--version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=15)
                return {'state':'found', 'platform':platform_name, 'executable':resolved, 'destination':destination}
            except Exception:
                return {'state':'invalid', 'platform':platform_name, 'executable':resolved, 'destination':destination}
        if os.path.lexists(candidate):
            return {'state':'invalid', 'platform':platform_name, 'executable':candidate, 'destination':destination}
    if explicit:
        return {'state':'invalid', 'platform':platform_name, 'executable':explicit, 'destination':destination}
    if platform.system() not in ('Linux', 'Darwin') or platform.machine().lower() not in ('x86_64', 'amd64', 'aarch64', 'arm64'):
        return {'state':'unsupported', 'platform':platform_name, 'destination':destination, 'detail':'Automatic installation is not supported on this host. Install manually: ' + manual}
    if is_wsl():
        # Editors usually run on Windows, so WSL uses the Windows CLI.
        if shutil.which('wslpath'):
            try:
                local = ps_output(powershell(), '$env:LOCALAPPDATA')
                binary = subprocess.check_output(['wslpath', '-u', local + chr(92) + chr(92).join(['Unity', 'bin', 'unity.exe'])], text=True, timeout=5).strip()
                if local and os.path.isfile(binary):
                    try:
                        subprocess.run([binary, '--version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=15)
                        return {'state':'found', 'platform':platform_name, 'executable':binary, 'destination':destination}
                    except (OSError, subprocess.SubprocessError):
                        return {'state':'invalid', 'platform':platform_name, 'executable':binary, 'destination':destination}
            except (OSError, subprocess.SubprocessError):
                pass
        return {'state':'missing', 'platform':platform_name, 'detail':'WSL: the Windows CLI is installed, for Windows Editors.'}
    return {'state':'missing', 'platform':platform_name, 'destination':destination}

def install_wsl():
    ps = powershell()
    windows_temp = ps_output(ps, '[IO.Path]::GetTempPath()')
    name = 'unity-install-' + os.urandom(8).hex() + '.ps1'
    script = os.path.join(subprocess.check_output(['wslpath', '-u', windows_temp], text=True, timeout=5).strip(), name)
    content = fetch('install.ps1')
    with open(script, 'xb') as file:
        file.write(b'\xef\xbb\xbf' + content)
    try:
        wslenv = 'UNITY_CLI_SKIP_SETUP' + (':' + os.environ['WSLENV'] if os.environ.get('WSLENV') else '')
        env = dict(os.environ, UNITY_CLI_SKIP_SETUP='1', WSLENV=wslenv)
        subprocess.run([ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windows_temp.rstrip(chr(92)) + chr(92) + name], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=240)
    finally:
        try:
            os.remove(script)
        except OSError:
            pass
    info = inspect()
    if info['state'] != 'found':
        raise RuntimeError('The installer finished but the Unity CLI was not found.')
    return info

def install_posix():
    parent = os.path.dirname(destination)
    os.makedirs(parent, mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.unity-install-', dir=parent) as temp:
        sandbox = os.path.join(temp, 'home')
        os.mkdir(sandbox, 0o700)
        script = os.path.join(temp, 'install.sh')
        with open(script, 'xb') as file:
            file.write(fetch('install.sh'))
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': sandbox, 'SHELL':'/bin/sh',
               'UNITY_CLI_HOME': os.path.join(temp, 'install'), 'UNITY_CLI_SKIP_SETUP':'1'}
        for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'):
            if key in os.environ:
                env[key] = os.environ[key]
        subprocess.run(['/bin/bash', script], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=240)
        binary = os.path.join(temp, 'install', 'bin', 'unity')
        subprocess.run([binary, '--version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=15)
        if inspect()['state'] != 'missing':
            raise RuntimeError('CLI appeared during installation; no existing file was replaced.')
        # Hard link is atomic and fails if the destination already exists.
        os.link(binary, destination)
    return {'state':'found', 'platform':platform_name, 'executable':destination, 'destination':destination}

try:
    info = inspect()
    if request['action'] == 'install':
        if info['state'] != 'missing':
            raise RuntimeError('CLI is no longer missing; no installation was attempted.')
        info = install_wsl() if is_wsl() else install_posix()
    print(json.dumps({'ok':True, 'result':info}))
except Exception as error:
    detail = str(error)
    if isinstance(error, subprocess.CalledProcessError):
        output = (error.stderr or b'') + (error.stdout or b'')
        if output:
            detail += ': ' + output.decode('utf-8', errors='replace')[-4000:]
    print(json.dumps({'ok':False, 'error':detail}))
`;

async function run(
  file: string,
  args: string[],
  options: { signal?: AbortSignal; timeout: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        signal: options.signal,
        timeout: options.timeout,
        env: options.env,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve(stdout);
      },
    );
    child.stdin?.end(); // An installer must never wait for input.
  });
}

async function findOnPath(name: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    try {
      await access(path.join(dir, name), constants.X_OK);
      return path.join(dir, name);
    } catch {
      /* Try the next directory. */
    }
  }
  return undefined;
}

/** PowerShell as seen from WSL, and the Windows CLI location it reports. */
async function wslWindows(
  signal?: AbortSignal,
): Promise<{ powershell: string; cli: string } | undefined> {
  try {
    const root = process.env.SystemRoot || "C:\\Windows";
    const powershell =
      (await findOnPath("powershell.exe")) ??
      (
        await run("wslpath", ["-u", `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`], {
          signal,
          timeout: 5000,
        })
      ).trim();
    const local = (
      await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", "$env:LOCALAPPDATA"], {
        signal,
        timeout: 20_000,
      })
    ).trim();
    if (!local) return undefined;
    const cli = (
      await run("wslpath", ["-u", `${local}\\Unity\\bin\\unity.exe`], { signal, timeout: 5000 })
    ).trim();
    return { powershell, cli };
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

async function versionOk(
  executable: string,
  signal?: AbortSignal,
): Promise<"ok" | "absent" | "broken"> {
  try {
    await run(executable, ["--version"], { signal, timeout: 15_000 });
    return "ok";
  } catch (error) {
    signal?.throwIfAborted();
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "broken";
  }
}

/** Inspect the local machine in Node, so no Python is needed and Windows and macOS behave like Linux. */
async function inspectLocal(signal?: AbortSignal): Promise<InstallInspection> {
  const explicit = process.env.PI_UNITY_CLI;
  const platform = `${hostProbe.platform()}-${hostProbe.arch()}`;
  const home = process.env.HOME || os.homedir();
  const managed = path.join(home, ".local", "share", "pi-agent-unity", "bin", "unity");
  const windowsDefault = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Unity", "bin", "unity.exe")
    : undefined;
  const destination = hostProbe.platform() === "win32" ? windowsDefault : managed;
  const candidates = explicit
    ? [explicit]
    : [
        "unity",
        managed,
        path.join(home, ".local", "bin", "unity"),
        path.join(home, ".unity", "bin", "unity"),
        ...(windowsDefault && hostProbe.platform() === "win32" ? [windowsDefault] : []),
      ];
  for (const executable of candidates) {
    const state = await versionOk(executable, signal);
    if (state === "ok") return { state: "found", platform, executable, destination };
    if (state === "broken") return { state: "invalid", platform, executable, destination };
  }
  if (explicit) return { state: "invalid", platform, executable: explicit, destination };
  const host = await detectHost();
  if (!host) return { state: "unsupported", platform, detail: unsupportedDetail };
  if (host.os === "wsl") {
    // Editors usually run on Windows, so WSL uses the Windows CLI.
    const windows = await wslWindows(signal);
    if (
      windows &&
      (await access(windows.cli).then(
        () => true,
        () => false,
      ))
    ) {
      return {
        state: (await versionOk(windows.cli, signal)) === "ok" ? "found" : "invalid",
        platform,
        executable: windows.cli,
      };
    }
    return {
      state: "missing",
      platform,
      detail: "WSL: the Windows CLI is installed, for Windows Editors.",
    };
  }
  return { state: "missing", platform, destination };
}

const proxyVariables = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

async function download(name: string, signal?: AbortSignal): Promise<Buffer> {
  const url = `${installerBase()}${name}`;
  try {
    const response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length > 1024 * 1024) throw new Error("Installer exceeds the expected size.");
    return content;
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      `Could not download ${url}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function tail(error: unknown): string {
  const failure = error as { message?: string; stdout?: string; stderr?: string };
  const output = `${failure.stderr ?? ""}${failure.stdout ?? ""}`.trim().slice(-2000);
  return output ? `${failure.message}: ${output}` : String(failure.message ?? error);
}

/** Linux and macOS: run install.sh in an isolated home, verify the result, then link it into place without overwriting. */
async function installPosix(destination: string, signal?: AbortSignal): Promise<void> {
  const script = await download("install.sh", signal);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(path.join(parent, ".unity-install-"));
  try {
    const sandbox = path.join(temp, "home");
    await mkdir(sandbox, { mode: 0o700 });
    const file = path.join(temp, "install.sh");
    await writeFile(file, script, { flag: "wx", mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: sandbox,
      SHELL: "/bin/sh",
      UNITY_CLI_HOME: path.join(temp, "install"),
      UNITY_CLI_SKIP_SETUP: "1",
    };
    for (const key of proxyVariables) if (process.env[key]) env[key] = process.env[key];
    await run("/bin/bash", [file], { signal, timeout: 240_000, env });
    const binary = path.join(temp, "install", "bin", "unity");
    await run(binary, ["--version"], { signal, timeout: 15_000 });
    if ((await inspectLocal(signal)).state !== "missing")
      throw new Error("CLI appeared during installation; no existing file was replaced.");
    await link(binary, destination); // Atomic, and fails if the destination already exists.
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** Windows and WSL: run install.ps1, which installs the Windows CLI to %LOCALAPPDATA%\Unity\bin and adds it to the user PATH. */
async function installWindows(host: NonNullable<LocalHost>, signal?: AbortSignal): Promise<void> {
  const script = await download("install.ps1", signal);
  const name = `unity-install-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}.ps1`;
  // A byte order mark makes Windows PowerShell read the file as UTF-8.
  const content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), script]);
  const env: NodeJS.ProcessEnv = { ...process.env, UNITY_CLI_SKIP_SETUP: "1" };
  let powershell: string;
  let file: string;
  let windowsFile: string;
  if (host.os === "wsl") {
    const windows = await wslWindows(signal);
    if (!windows)
      throw new Error(
        "PowerShell is not reachable from WSL, so the Windows CLI cannot be installed.",
      );
    powershell = windows.powershell;
    const windowsTemp = (
      await run(
        powershell,
        ["-NoProfile", "-NonInteractive", "-Command", "[IO.Path]::GetTempPath()"],
        { signal, timeout: 20_000 },
      )
    ).trim();
    file = path.join(
      (await run("wslpath", ["-u", windowsTemp], { signal, timeout: 5000 })).trim(),
      name,
    );
    windowsFile = `${windowsTemp.replace(/\\$/, "")}\\${name}`;
    env.WSLENV = `UNITY_CLI_SKIP_SETUP${process.env.WSLENV ? `:${process.env.WSLENV}` : ""}`;
  } else {
    powershell =
      (await findOnPath("powershell.exe")) ??
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
    file = windowsFile = path.join(os.tmpdir(), name);
  }
  await writeFile(file, content, { flag: "wx", mode: 0o600 });
  try {
    await run(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", windowsFile],
      { signal, timeout: 240_000, env },
    );
  } finally {
    await rm(file, { force: true });
  }
}

async function installLocal(signal?: AbortSignal): Promise<InstallInspection> {
  const before = await inspectLocal(signal);
  if (before.state !== "missing")
    throw new Error("CLI is no longer missing; no installation was attempted.");
  const host = await detectHost();
  if (!host) throw new Error(unsupportedDetail);
  try {
    if (host.os === "windows" || host.os === "wsl") await installWindows(host, signal);
    else {
      if (!before.destination) throw new Error("The CLI installation destination is unavailable.");
      await installPosix(before.destination, signal);
    }
  } catch (error) {
    if (signal?.aborted)
      throw new Error(
        "Installation was cancelled and its effect may be unknown; inspect before retrying.",
        { cause: error },
      );
    throw new Error(`Unity CLI installation failed: ${tail(error)}`, { cause: error });
  }
  const after = await inspectLocal(signal);
  if (after.state !== "found")
    throw new Error(
      `The installer finished but the Unity CLI was not found${after.executable ? ` (${after.executable} is not usable)` : ""}.`,
    );
  return after;
}

async function execute(
  action: "inspect" | "install",
  target: SshTarget,
  signal?: AbortSignal,
): Promise<InstallInspection> {
  const explicit = process.env.PI_UNITY_REMOTE_CLI;
  const args = [
    "-c",
    program,
    JSON.stringify({ action, explicit: explicit || undefined, base: installerBase() }),
  ];
  let stdout: string;
  try {
    ({ stdout } = await exec("ssh", sshArguments(target, "python3", args), {
      signal,
      timeout: action === "install" ? 300_000 : 30_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    if (signal?.aborted && action !== "install") throw error;
    throw new Error(
      `SSH target ${target.id} could not be reached or run.${action === "install" ? " Installation effect may be unknown; inspect before retrying." : ""}`,
      { cause: error },
    );
  }
  let envelope: { ok: boolean; result?: InstallInspection; error?: string };
  try {
    envelope = JSON.parse(stdout) as { ok: boolean; result?: InstallInspection; error?: string };
  } catch (error) {
    throw new Error("CLI installation probe returned an invalid response.", { cause: error });
  }
  if (!envelope.ok || !envelope.result)
    throw new Error(`Unity CLI ${action} failed: ${envelope.error || "unknown failure"}`);
  return envelope.result;
}

/** Inspect a fixed local or SSH target without installing anything. */
export async function inspectInstallation(
  target?: SshTarget,
  signal?: AbortSignal,
): Promise<InstallInspection> {
  return target ? execute("inspect", target, signal) : inspectLocal(signal);
}

/** Caller must obtain explicit user consent for this target before invoking installation. */
export async function installCli(options: {
  confirmed: boolean;
  target?: SshTarget;
  signal?: AbortSignal;
}): Promise<InstallInspection> {
  if (!options.confirmed) throw new Error("Unity CLI installation was not confirmed.");
  if (options.target ? process.env.PI_UNITY_REMOTE_CLI : process.env.PI_UNITY_CLI)
    throw new Error("A CLI executable is configured; installation will not replace it.");
  return options.target
    ? execute("install", options.target, options.signal)
    : installLocal(options.signal);
}
