import type { SshTarget } from "./ssh.ts";
import { remoteLocation, type SshTargetOs } from "./identity.ts";
import { packagedSource } from "./packaged-source.ts";

/** The declared OS family of a target; records without `os` are Linux targets. */
export function targetOs(target: Pick<SshTarget, "os">): SshTargetOs {
  return target.os ?? "linux";
}

/** A directory that always exists and restricts nothing: the root of the workspace's drive. */
export function neutralDirectory(target: Pick<SshTarget, "os" | "workspace">): string {
  return targetOs(target) === "windows" ? `${target.workspace.slice(0, 3)}/` : "/";
}

/** Validate configured aliases without reading credentials or probing the host. */
export function validateSshTarget(target: SshTarget): void {
  remoteLocation(target.id, target.workspace, targetOs(target));
  if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(target.host))
    throw new TypeError("SSH host must be an OpenSSH host alias, not a command or URI");
}

/** Python source that the target's channel worker runs with its own interpreter.
 * The source travels on stdin, so its size never meets a command-line limit, and the
 * target never needs a `python3` executable on PATH.
 */
export interface RemotePythonProgram {
  readonly python: string;
}

/** An executable name, or an IDE Python program. */
export type SshCommand = string | RemotePythonProgram;

/** Wrap Python source as a remote program. */
export function remotePython(source: string): RemotePythonProgram {
  return { python: source };
}

const workerFiles = [
  "ssh-channel-worker.py",
  "ssh_channel_common.py",
  "ssh_channel_posix.py",
  "ssh_channel_windows.py",
  "ssh-worker.py",
  "ssh_worker_common.py",
  "ssh_worker_posix.py",
  "ssh_worker_windows.py",
  "ssh_paths.py",
  "ssh_windows_files.py",
  "ssh-transfer-worker.py",
  "ssh-transfer-worker-windows.py",
] as const;
type WorkerFile = (typeof workerFiles)[number];
// Every worker is read with this module, so the workers always match the loaded TypeScript.
const sources = new Map(
  workerFiles.map((name) => [name, packagedSource(new URL(`./${name}`, import.meta.url))] as const),
);
function workerSource(name: WorkerFile): Promise<string> {
  const source = sources.get(name);
  if (source === undefined) throw new Error(`Unknown SSH worker source: ${name}`);
  return source;
}

/** Combine an entry and its modules into one program. Modules import by name. */
export function bundlePython(entry: string, modules: Readonly<Record<string, string>>): string {
  // JSON string literals are valid Python string literals.
  const table = Object.entries(modules)
    .map(([name, source]) => `${JSON.stringify(name)}:${JSON.stringify(source)}`)
    .join(",");
  return [
    "import importlib.abc as _pi_abc, importlib.util as _pi_util, sys as _pi_sys",
    `_pi_modules = {${table}}`,
    "class _PiLoader(_pi_abc.Loader):",
    "    def __init__(self, source): self.source = source",
    "    def create_module(self, spec): return None",
    "    def exec_module(self, module):",
    "        exec(compile(self.source, '<pi-agent-ide/' + module.__name__ + '>', 'exec'), module.__dict__)",
    "class _PiFinder(_pi_abc.MetaPathFinder):",
    "    def find_spec(self, name, path=None, target=None):",
    "        source = _pi_modules.get(name)",
    "        return None if source is None else _pi_util.spec_from_loader(name, _PiLoader(source))",
    "_pi_sys.meta_path.insert(0, _PiFinder())",
    entry,
  ].join("\n");
}

const workers = {
  channel: {
    entry: "ssh-channel-worker.py",
    common: "ssh_channel_common",
    platform: "ssh_channel",
  },
  file: { entry: "ssh-worker.py", common: "ssh_worker_common", platform: "ssh_worker" },
} as const;

/** Windows file primitives, used by the file worker and the transfer worker. */
const windowsFiles = "ssh_windows_files";

const bundles = new Map<string, Promise<string>>();
/** The channel or file-operation worker, bundled with the target platform's module. */
export function sshWorkerBundle(os: SshTargetOs, kind: keyof typeof workers): Promise<string> {
  const key = `${os}:${kind}`;
  let bundle = bundles.get(key);
  if (!bundle) {
    const worker = workers[kind];
    const platform: WorkerFile = `${worker.platform}_${os === "windows" ? "windows" : "posix"}.py`;
    // Only the Windows file worker needs the shared Windows primitives.
    const files =
      os === "windows" && kind === "file" ? workerSource(`${windowsFiles}.py`) : undefined;
    bundle = Promise.all([
      workerSource(worker.entry),
      workerSource(`${worker.common}.py`),
      workerSource("ssh_paths.py"),
      workerSource(platform),
      files,
    ]).then(([entry, common, paths, native, windows]) =>
      bundlePython(entry, {
        [worker.common]: common,
        ssh_paths: paths,
        [`${worker.platform}_platform`]: native,
        ...(windows === undefined ? {} : { [windowsFiles]: windows }),
      }),
    );
    bundles.set(key, bundle);
  }
  return bundle;
}

/** The program that receives a streamed file on a target and publishes it after its checksum.
 * Linux runs the standalone worker; Windows bundles it with the shared file primitives.
 */
export function sshTransferProgram(os: SshTargetOs): Promise<string> {
  const key = `${os}:transfer`;
  let bundle = bundles.get(key);
  if (!bundle) {
    bundle =
      os === "windows"
        ? Promise.all([
            workerSource("ssh-transfer-worker-windows.py"),
            workerSource("ssh_worker_common.py"),
            workerSource("ssh_paths.py"),
            workerSource(`${windowsFiles}.py`),
          ]).then(([entry, common, paths, files]) =>
            bundlePython(entry, {
              ssh_worker_common: common,
              ssh_paths: paths,
              [windowsFiles]: files,
            }),
          )
        : workerSource("ssh-transfer-worker.py");
    bundles.set(key, bundle);
  }
  return bundle;
}

/** Interpreter commands tried in order. The Windows Store `python3` alias is not Python. */
export function interpreterCandidates(os: SshTargetOs): readonly string[] {
  return os === "windows" ? ["py -3", "python"] : ["python3"];
}

// Valid unchanged in bash, fish, zsh, sh, cmd.exe, Windows PowerShell and pwsh:
// no quotes, `$`, backslashes or backticks inside the double-quoted argument.
const bootstrap = "import sys;exec(sys.stdin.buffer.raw.readline())";

/** Fixed remote command; programs and requests travel on stdin, never in shell source. */
export function sshBootstrapCommand(interpreter: string): string {
  return `${interpreter} -c "${bootstrap}"`;
}

/** Prefix of the line the loader prints before running the channel worker. */
export const WORKER_HANDSHAKE = "pi-agent-ide-worker:";

/** Bootstrap stdin: a one-line loader, then the length-prefixed program.
 * The loader reports the target platform before running anything and stops on a
 * platform that does not match the declared OS.
 */
export function sshBootstrapInput(os: SshTargetOs, program: string): Buffer {
  const accepted = os === "windows" ? 'sys.platform=="win32"' : 'sys.platform.startswith("linux")';
  const loader = [
    "import json,os,sys",
    "def _pi_read(n):",
    " b=bytearray()",
    " while len(b)<n:",
    "  c=os.read(0,n-len(b))",
    "  if not c:raise SystemExit(70)",
    "  b+=c",
    " return bytes(b)",
    `_pi_ok=${accepted}`,
    `os.write(1,b"\\n${WORKER_HANDSHAKE}"+json.dumps({"platform":sys.platform,"accepted":_pi_ok}).encode()+b"\\n")`,
    "if not _pi_ok:raise SystemExit(0)",
    "exec(compile(_pi_read(int(_pi_read(10))),'<pi-agent-ide>','exec'))",
  ].join("\n");
  const body = Buffer.from(program, "utf8");
  return Buffer.concat([
    Buffer.from(`exec(${JSON.stringify(loader)})\n`, "utf8"),
    Buffer.from(String(body.length).padStart(10, "0"), "ascii"),
    body,
  ]);
}

/** Safe system OpenSSH options shared by short operations, service channels and masters. */
export function sshSecurityOptions(target: SshTarget): string[] {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ClearAllForwardings=yes",
  ];
  if (target.configFile !== undefined) args.push("-F", target.configFile);
  return args;
}

/** Arguments of one OpenSSH process; `route` options select a connection, such as a master. */
export function systemSshArguments(
  target: SshTarget,
  command: string,
  route: readonly string[] = [],
): string[] {
  return ["-T", ...sshSecurityOptions(target), ...route, "--", target.host, command];
}

/** Classify bounded SSH diagnostics without returning their text or credential paths.
 * Only OpenSSH's own exit status 255 is a transport failure; any other status before the
 * worker handshake comes from the remote shell. Unrelated profile errors on stderr do not
 * count as a missing interpreter.
 */
export function sshFailureCode(
  exitCode: number | null,
  stderr: string,
  interpreter = "python3",
): string {
  if (
    /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/u.test(
      stderr,
    )
  )
    return "HOST_KEY_FAILED";
  if (/Permission denied \([^)]*\)/u.test(stderr)) return "AUTH_FAILED";
  if (exitCode === 255) return "TRANSPORT_FAILED";
  const [command = ""] = interpreter.split(" ");
  const name = command.replaceAll(/[^A-Za-z0-9_-]/gu, "");
  const missing = new RegExp(
    [
      `\\b${name}:\\s*(?:command\\s+)?not found`,
      `Unknown command:?\\s*'?${name}\\b`,
      `'${name}' is not recognized`,
      "Python was not found",
    ].join("|"),
    "u",
  );
  return missing.test(stderr) ? "DEPENDENCY_UNAVAILABLE" : "TRANSPORT_FAILED";
}
