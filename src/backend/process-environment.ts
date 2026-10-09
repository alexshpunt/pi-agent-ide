import path from "node:path";
import type { SshBackend } from "./ssh.js";
import { SshBackendError } from "./ssh.js";

/** Read only remote PATH and prepend the existing project executable directories. */
export async function sshProjectEnvironment(
  backend: SshBackend,
  cwd: string,
  configured: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  signal?.throwIfAborted();
  for (const key of Object.keys(configured)) {
    if (!/^[A-Za-z_][A-Za-z\d_]*$/u.test(key))
      throw new TypeError("Invalid remote process environment key");
  }
  const remotePath = await backend.execute(
    "python3",
    ["-c", 'import os; print(os.environ.get("PATH", os.defpath), end="")'],
    cwd,
    { signal },
  );
  if (remotePath.exitCode !== 0)
    throw new SshBackendError("DEPENDENCY_UNAVAILABLE", backend.target.id, "not-applied");
  return {
    ...configured,
    PATH: [
      ...["node_modules/.bin", ".venv/bin", "venv/bin", "vendor/bin"].map((directory) =>
        path.posix.join(cwd, directory),
      ),
      configured.PATH ?? remotePath.stdout,
    ].join(":"),
  };
}

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
  const candidates = configs.map((config) => {
    for (const key of Object.keys(config.env ?? {}))
      if (!/^[A-Za-z_][A-Za-z\d_]*$/u.test(key))
        throw new TypeError("Invalid remote process environment key");
    return {
      command: config.command[0]?.replaceAll("{project}", cwd) ?? "",
      path: config.env?.PATH,
    };
  });
  const result = await backend.execute(
    "python3",
    [
      "-c",
      "import json,os,shutil,sys; candidates=json.loads(sys.argv[1]); root=sys.argv[2]; prefixes=[os.path.join(root,p) for p in ['node_modules/.bin','.venv/bin','venv/bin','vendor/bin']]; print(json.dumps([bool(shutil.which(c['command'],path=os.pathsep.join(prefixes+[c.get('path',os.environ.get('PATH',os.defpath))]))) for c in candidates]))",
      JSON.stringify(candidates),
      cwd,
    ],
    cwd,
    { signal },
  );
  if (result.exitCode !== 0)
    throw new SshBackendError("DEPENDENCY_UNAVAILABLE", backend.target.id, "not-applied");
  const values: unknown = JSON.parse(result.stdout.toString("utf8"));
  if (
    !Array.isArray(values) ||
    values.length !== configs.length ||
    values.some((value) => typeof value !== "boolean")
  )
    throw new SshBackendError("INVALID_RESPONSE", backend.target.id, "not-applied");
  return values as boolean[];
}
