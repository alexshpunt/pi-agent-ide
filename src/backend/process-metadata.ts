import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { SshBackendRegistry } from "./registry.ts";
import { SshBackendError } from "./ssh.ts";
import { bundlePython, remotePython, targetOs } from "./ssh-transport.ts";
import { packagedSource } from "./packaged-source.ts";

const rowSchema = Type.Object({
  pid: Type.Integer({ minimum: 1 }),
  parentPid: Type.Integer({ minimum: 0 }),
  command: Type.String(),
  started: Type.String(),
  identity: Type.String({ pattern: "^[a-f0-9-]+:[0-9]+$" }),
  executable: Type.Union([Type.String(), Type.Null()]),
});
const resultSchema = Type.Object({ processes: Type.Array(rowSchema) });
const worker = packagedSource(new URL("./process-metadata-worker.py", import.meta.url));
const windowsWorker = packagedSource(new URL("./process-metadata-windows.py", import.meta.url));
const windowsProgram = windowsWorker.then((windows) =>
  bundlePython(
    `import json, sys
from pi_windows_process import metadata
try:
    result = {"processes": [metadata(int(sys.argv[1]))]}
except ProcessLookupError:
    result = {"error": "ENOENT"}
except PermissionError:
    result = {"error": "EACCES"}
except OSError:
    result = {"error": "CAPABILITY_UNAVAILABLE"}
print(json.dumps(result, ensure_ascii=True))`,
    { pi_windows_process: windows },
  ),
);

type SshProcessMetadata = Static<typeof rowSchema>;

/** Check one owned PID before cleanup; never enumerate the target's processes.
 * Return undefined only when the target OS confirms absence. Transport and permission
 * failures do not prove process death, and must not authorize cleanup.
 */
export async function findSshProcessMetadata(
  registry: SshBackendRegistry,
  scope: string,
  pid: number,
  signal?: AbortSignal,
): Promise<SshProcessMetadata | undefined> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid process PID");
  const owner = registry.resolve(scope);
  if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", scope, "not-applied");
  const result = await owner.backend.execute(
    remotePython(await (targetOs(owner.backend.target) === "windows" ? windowsProgram : worker)),
    [String(pid)],
    owner.location.path,
    { signal },
  );
  signal?.throwIfAborted();
  if (result.exitCode !== 0)
    throw new SshBackendError("CAPABILITY_UNAVAILABLE", scope, "not-applied");
  let data: unknown;
  try {
    data = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new SshBackendError("INVALID_RESPONSE", scope, "not-applied");
  }
  if (typeof data === "object" && data !== null && "error" in data) {
    if (data.error === "ENOENT") return undefined;
    const codes = new Set(["CAPABILITY_UNAVAILABLE", "EACCES", "BYTE_LIMIT"]);
    throw new SshBackendError(
      typeof data.error === "string" && codes.has(data.error) ? data.error : "INVALID_RESPONSE",
      scope,
      "not-applied",
    );
  }
  if (
    !Value.Check(resultSchema, data) ||
    data.processes.length !== 1 ||
    data.processes[0]?.pid !== pid
  )
    throw new SshBackendError("INVALID_RESPONSE", scope, "not-applied");
  return data.processes[0];
}
