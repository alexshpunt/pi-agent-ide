import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { SshBackendRegistry } from "./registry.js";
import { SshBackendError } from "./ssh.js";

const rowSchema = Type.Object({
  pid: Type.Integer({ minimum: 1 }),
  parentPid: Type.Integer({ minimum: 0 }),
  command: Type.String(),
  started: Type.String(),
  identity: Type.String({ pattern: "^[a-f0-9-]+:[0-9]+$" }),
  executable: Type.Union([Type.String(), Type.Null()]),
});
const resultSchema = Type.Object({ processes: Type.Array(rowSchema) });
let worker: Promise<string> | undefined;

/** A read-only process snapshot. Identity combines the target boot ID and native start ticks. */
export interface SshProcessMetadata extends Static<typeof rowSchema> {
  readonly host: "ssh";
  readonly target: string;
  readonly resource: string;
  /** Discovery alone never grants control or window access. */
  readonly owned: false;
}

/** Inspect only a configured Linux target, without treating any remote PID as controller-local. */
export async function readSshProcessMetadata(
  registry: SshBackendRegistry,
  scope: string,
  pid?: number,
  signal?: AbortSignal,
): Promise<readonly SshProcessMetadata[]> {
  return readSshProcessRows(registry, scope, pid, signal, false);
}

/** Return undefined only when the native /proc probe confirms this PID is absent.
 * Transport, cwd and permission failures still throw; they never prove process death.
 */
export async function findSshProcessMetadata(
  registry: SshBackendRegistry,
  scope: string,
  pid: number,
  signal?: AbortSignal,
): Promise<SshProcessMetadata | undefined> {
  return (await readSshProcessRows(registry, scope, pid, signal, true))[0];
}

async function readSshProcessRows(
  registry: SshBackendRegistry,
  scope: string,
  pid: number | undefined,
  signal: AbortSignal | undefined,
  missingIsEmpty: boolean,
): Promise<readonly SshProcessMetadata[]> {
  signal?.throwIfAborted();
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1))
    throw new Error("Invalid process PID");
  const owner = registry.resolve(scope);
  if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", scope, "not-applied");
  worker ??= readFile(new URL("./process-metadata-worker.py", import.meta.url), "utf8");
  const result = await owner.backend.execute(
    "python3",
    ["-c", await worker, ...(pid === undefined ? [] : [String(pid)])],
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
    if (missingIsEmpty && pid !== undefined && data.error === "ENOENT") return [];
    const codes = new Set(["CAPABILITY_UNAVAILABLE", "ENOENT", "EACCES", "BYTE_LIMIT"]);
    throw new SshBackendError(
      typeof data.error === "string" && codes.has(data.error) ? data.error : "INVALID_RESPONSE",
      scope,
      "not-applied",
    );
  }
  if (
    !Value.Check(resultSchema, data) ||
    (pid !== undefined && (data.processes.length !== 1 || data.processes[0]?.pid !== pid)) ||
    new Set(data.processes.map((item) => item.pid)).size !== data.processes.length
  )
    throw new SshBackendError("INVALID_RESPONSE", scope, "not-applied");
  return data.processes.map((item) => ({
    ...item,
    target: owner.location.target,
    host: "ssh",
    owned: false,
    resource: `process:ssh://${owner.location.target}/${item.pid}`,
  }));
}
