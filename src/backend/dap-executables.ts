import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SshBackend } from "./ssh.ts";
import { SshBackendError } from "./ssh.ts";
import { bundlePython, remotePython, targetOs } from "./ssh-transport.ts";
import { projectExecutableDirectories } from "./process-environment.ts";
import { packagedSource } from "./packaged-source.ts";

const worker = packagedSource(new URL("./dap-executable-worker.py", import.meta.url));
const windowsCommands = packagedSource(new URL("./ssh_windows_commands.py", import.meta.url));
const commandSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  files: Type.Array(Type.String()),
});

export function missingDebuggerDependency(source: string, dependency: string): SshBackendError {
  const error = new SshBackendError("DEPENDENCY_UNAVAILABLE", source, "not-applied");
  error.message += ` (target requires ${dependency})`;
  return error;
}

/** Resolve target overrides and check adapter-specific prerequisites without passing back environment values. */
export async function resolveSshDebuggerExecutable(
  backend: SshBackend,
  cwd: string,
  source: string,
  input: {
    readonly command: string;
    readonly overrides?: readonly string[];
    readonly python?: boolean;
    readonly files?: readonly string[];
    readonly fileOverrides?: readonly (readonly [string, string])[];
    readonly dependency: string;
  },
  signal?: AbortSignal,
): Promise<{ command: string; files: string[] }> {
  signal?.throwIfAborted();
  const os = targetOs(backend.target);
  const program =
    os === "windows"
      ? bundlePython(await worker, { ssh_windows_commands: await windowsCommands })
      : await worker;
  const request = { ...input, prefixes: projectExecutableDirectories(cwd, os) };
  const result = await backend.execute(remotePython(program), [JSON.stringify(request)], cwd, {
    signal,
  });
  if (result.exitCode === 3) throw missingDebuggerDependency(source, input.dependency);
  if (result.exitCode !== 0) throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
  let receipt: unknown;
  try {
    receipt = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
  }
  if (!Value.Check(commandSchema, receipt))
    throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
  return receipt;
}
