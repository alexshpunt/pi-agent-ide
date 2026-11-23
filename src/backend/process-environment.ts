import path from "node:path";
import type { SshTargetOs } from "./identity.ts";
import type { SshBackend } from "./ssh.ts";
import { SshBackendError } from "./ssh.ts";
import { bundlePython, remotePython, targetOs } from "./ssh-transport.ts";
import { packagedSource } from "./packaged-source.ts";
import { sshNativePath } from "./native-path.ts";

const windowsCommands = packagedSource(new URL("./ssh_windows_commands.py", import.meta.url));

/** Read only remote PATH and prepend project-local executable directories. */
export async function sshProjectEnvironment(
  backend: SshBackend,
  cwd: string,
  configured: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  signal?.throwIfAborted();
  const os = targetOs(backend.target);
  const environment = configuredEnvironment(configured, os);
  const remotePath = environment.PATH ?? (await readRemotePath(backend, cwd, signal));
  return {
    ...environment,
    PATH: [...projectExecutableDirectories(cwd, os), remotePath].join(projectPath(os).delimiter),
  };
}

function configuredEnvironment(
  values: Readonly<Record<string, string>>,
  os: SshTargetOs,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z\\d_]*$/u.test(key))
        throw new TypeError("Invalid remote process environment key");
      return [os === "windows" ? key.toUpperCase() : key, value];
    }),
  );
}

function projectPath(os: SshTargetOs) {
  return os === "windows" ? path.win32 : path.posix;
}

/** Native project-relative command lookup prefixes, in search order. */
export function projectExecutableDirectories(cwd: string, os: SshTargetOs): string[] {
  const native = sshNativePath(cwd, os);
  const venvBin = os === "windows" ? "Scripts" : "bin";
  return ["node_modules/.bin", `.venv/${venvBin}`, `venv/${venvBin}`, "vendor/bin"].map(
    (directory) => projectPath(os).join(native, directory),
  );
}

async function readRemotePath(backend: SshBackend, cwd: string, signal?: AbortSignal) {
  const result = await backend.execute(
    remotePython(
      'import os,sys; sys.stdout.buffer.write(os.environ.get("PATH", os.defpath).encode("utf8"))',
    ),
    [],
    cwd,
    { signal },
  );
  if (result.exitCode !== 0)
    throw new SshBackendError("DEPENDENCY_UNAVAILABLE", backend.target.id, "not-applied");
  return result.stdout.toString("utf8");
}

const discoveryProgram = `
import json, os, shutil, sys

def available(candidate, prefixes):
    command = candidate["command"]
    if not command:
        return False
    environment = dict(os.environ)
    if "path" in candidate:
        environment["PATH"] = candidate["path"]
    if "pathExt" in candidate:
        environment["PATHEXT"] = candidate["pathExt"]
    environment["PATH"] = os.pathsep.join(prefixes + [environment.get("PATH", os.defpath)])
    if os.name == "nt":
        from ssh_windows_commands import find_executable
        return find_executable(command, os.getcwd(), environment) is not None
    return shutil.which(command, path=environment["PATH"]) is not None

candidates = json.loads(sys.argv[1])
prefixes = json.loads(sys.argv[2])
print(json.dumps([available(candidate, prefixes) for candidate in candidates]))
`;

/** Check a candidate set in one owner operation without launching tools or returning environment values. */
export async function sshProjectExecutableAvailability(
  backend: SshBackend,
  cwd: string,
  configs: readonly {
    readonly command: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  }[],
  signal?: AbortSignal,
): Promise<readonly boolean[]> {
  signal?.throwIfAborted();
  const os = targetOs(backend.target);
  const native = sshNativePath(cwd, os);
  const candidates = configs.map((config) => {
    const environment = configuredEnvironment(config.env ?? {}, os);
    return {
      command: config.command[0]?.replaceAll("{project}", native) ?? "",
      path: environment.PATH,
      ...(os === "windows" && { pathExt: environment.PATHEXT }),
    };
  });
  const program =
    os === "windows"
      ? bundlePython(discoveryProgram, { ssh_windows_commands: await windowsCommands })
      : discoveryProgram;
  const result = await backend.execute(
    remotePython(program),
    [JSON.stringify(candidates), JSON.stringify(projectExecutableDirectories(cwd, os))],
    cwd,
    { signal },
  );
  if (result.exitCode !== 0)
    throw new SshBackendError("DEPENDENCY_UNAVAILABLE", backend.target.id, "not-applied");
  let values: unknown;
  try {
    values = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new SshBackendError("INVALID_RESPONSE", backend.target.id, "not-applied");
  }
  if (
    !Array.isArray(values) ||
    values.length !== configs.length ||
    values.some((value) => typeof value !== "boolean")
  )
    throw new SshBackendError("INVALID_RESPONSE", backend.target.id, "not-applied");
  return values as boolean[];
}

/** Preserve the backend error code and name the executable to install or configure on the owner. */
export function missingSshExecutable(error: unknown, command: string, target: string): unknown {
  if (!(error instanceof SshBackendError) || error.code !== "ENOENT") return error;
  error.message = `${error.message}: cannot find ${JSON.stringify(command)} on SSH target ${target}`;
  return error;
}
