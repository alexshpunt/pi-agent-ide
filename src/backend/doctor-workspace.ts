import { readFile } from "node:fs/promises";
import path from "node:path";
import { requiredValue } from "pi-agent-invariant";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { DoctorWorkspace } from "#src/api/doctor.js";
import { DOCTOR_TOOL_PATH_KEYS } from "#src/api/doctor.js";
import { createSshToolConfigAccess } from "./tool-config-access.js";
import { createSshConfiguredProcessAccess } from "./configured-process.js";
import { createSshLspTransport } from "./lsp-transport.js";
import { sshProjectExecutableAvailability } from "./process-environment.js";
import { inspectSshRecipeEvidence } from "./recipe-evidence.js";
import { remoteLocation } from "./identity.js";
import { readOwnedSshCommand } from "./owned-read-command.js";
import { startSshProcess, type SshProcessChannel } from "./ssh-channel.js";
import { SshBackendError } from "./ssh.js";
import { probeSshBrowser } from "./web-browser.js";
import { probeSshCapture } from "./vision-capture.js";
import type { SshBackendRegistry } from "./registry.js";

const probeSchema = Type.Object({
  directory: Type.String(),
  device: Type.String({ pattern: "^[0-9]+$" }),
  inode: Type.String({ pattern: "^[0-9]+$" }),
  containerCreated: Type.Boolean(),
  containerDevice: Type.String({ pattern: "^[0-9]+$" }),
  containerInode: Type.String({ pattern: "^[0-9]+$" }),
});

interface ProbeLease {
  users: number;
  created?: { container: string; device: string; inode: string };
  cleanup?: Promise<void>;
  allocation?: Promise<void>;
}

/** Resolve only an explicitly selected SSH project; construction does not contact other targets. */
export async function createSshDoctorWorkspace(
  registry: SshBackendRegistry,
  source: string,
  signal?: AbortSignal,
): Promise<DoctorWorkspace> {
  signal?.throwIfAborted();
  const owner = registry.resolve(source);
  if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
  const root = owner.location;
  const backend = owner.backend;
  if ((await backend.stat(root.path, { signal })).kind !== "directory")
    throw new SshBackendError("NOT_DIRECTORY", root.source, "not-applied");
  const resolve = (resource: string) => {
    const location = registry.resolve(resource);
    if (!location || location.location.target !== root.target)
      throw new SshBackendError("UNSUPPORTED_SOURCE", resource, "not-applied");
    return location.location.path;
  };
  const pathReceipt = await readOwnedSshCommand(
    { ...backend.target, workspace: root.path },
    "python3",
    [
      "-c",
      "import json,os,sys; keys=json.loads(sys.argv[1]); print(json.dumps({k:os.environ[k] for k in keys if k in os.environ}))",
      JSON.stringify(DOCTOR_TOOL_PATH_KEYS),
    ],
    root.source,
    { signal, timeoutMs: 5_000, maxBytes: 128 * 1024 },
  );
  if (pathReceipt.exitCode !== 0)
    throw new SshBackendError("DEPENDENCY_UNAVAILABLE", root.source, "not-applied");
  const toolPaths: unknown = JSON.parse(pathReceipt.stdout.toString("utf8"));
  const toolPathsSchema = Type.Object(
    Object.fromEntries(
      DOCTOR_TOOL_PATH_KEYS.map((key) => [key, Type.Optional(Type.String({ maxLength: 4096 }))]),
    ),
    { additionalProperties: false },
  );
  if (!Value.Check(toolPathsSchema, toolPaths))
    throw new SshBackendError("INVALID_RESPONSE", root.source, "not-applied");
  const layerAccess = createSshToolConfigAccess(registry);
  const processAccess = createSshConfiguredProcessAccess(registry);
  const transport = createSshLspTransport(registry, root.source);
  const snapshots = new Map<string, { content: string; version: string }>();
  const executeWorker = async (
    name: "doctor-inventory-worker.py" | "doctor-probe-worker.py",
    args: readonly string[],
    requestSignal?: AbortSignal,
  ): Promise<unknown> => {
    const script = await readFile(new URL(`./${name}`, import.meta.url), {
      encoding: "utf8",
      signal: requestSignal,
    });
    const result = await readOwnedSshCommand(
      backend.target,
      "python3",
      ["-c", script, ...args],
      root.source,
      { signal: requestSignal, timeoutMs: 30000, maxBytes: 32 * 1024 * 1024 },
    );
    if (result.exitCode !== 0)
      throw new SshBackendError("DOCTOR_FAILED", root.source, "not-applied");
    return JSON.parse(result.stdout.toString("utf8")) as unknown;
  };
  // Native exit confirms the handoff; interrupted acknowledgements still retain a known receipt.
  const allocateProbe = async (
    file: string,
    retain: (data: Static<typeof probeSchema>) => void,
    requestSignal?: AbortSignal,
  ): Promise<void> => {
    requestSignal?.throwIfAborted();
    const script = await readFile(new URL("./doctor-probe-worker.py", import.meta.url), {
      encoding: "utf8",
      signal: requestSignal,
    });
    const deadline = new AbortController();
    const operationSignal = requestSignal
      ? AbortSignal.any([requestSignal, deadline.signal])
      : deadline.signal;
    const timer = setTimeout(
      () => deadline.abort(new SshBackendError("TIMEOUT", root.source, "not-applied")),
      30_000,
    );
    let channel: SshProcessChannel | undefined;
    let failed = false;
    let failure: unknown;
    let received: Static<typeof probeSchema> | undefined;
    try {
      channel = await startSshProcess(
        backend.target,
        "python3",
        ["-c", script, JSON.stringify({ operation: "create", source: file })],
        backend.target.workspace,
        { signal: operationSignal },
      );
      let outputLength = 0;
      const consume = (bytes: Buffer) => {
        outputLength += bytes.length;
        if (outputLength <= 128 * 1024) return true;
        deadline.abort(new SshBackendError("BYTE_LIMIT", root.source, "not-applied"));
        return false;
      };
      channel.stderr.on("data", (bytes: Buffer) => {
        consume(bytes);
      });
      const active = channel;
      const receipt = new Promise<unknown>((resolveReceipt, rejectReceipt) => {
        let buffer = Buffer.alloc(0);
        let complete = false;
        active.stdout.on("data", (bytes: Buffer) => {
          if (!consume(bytes) || complete) return;
          buffer = Buffer.concat([buffer, bytes]);
          const end = buffer.indexOf("\n");
          if (end < 0) return;
          complete = true;
          try {
            resolveReceipt(JSON.parse(buffer.subarray(0, end).toString("utf8")) as unknown);
          } catch (error) {
            rejectReceipt(error);
          }
          buffer = Buffer.alloc(0);
        });
      });
      const data = await Promise.race([
        receipt,
        channel.completion.then(() => {
          throw new SshBackendError("PROBE_FAILED", root.source, "not-applied");
        }),
      ]);
      requestSignal?.throwIfAborted();
      if (!Value.Check(probeSchema, data))
        throw new SshBackendError("PROBE_FAILED", root.source, "not-applied");
      received = data;
      await channel.write(Buffer.from("retain\n"));
      await channel.end();
      if ((await channel.completion).exitCode !== 0)
        throw new SshBackendError("PROBE_FAILED", root.source, "not-applied");
    } catch (error) {
      failed = true;
      failure = requestSignal?.aborted
        ? requestSignal.reason
        : deadline.signal.aborted
          ? deadline.signal.reason
          : error;
    } finally {
      clearTimeout(timer);
    }
    try {
      const stopped = await channel?.stop();
      if (stopped?.exitCode === 0 && received) retain(received);
      if (stopped?.exitCode === 2)
        throw new SshBackendError("PROBE_CLEANUP_FAILED", root.source, "unknown");
    } catch (cleanupError) {
      throw new AggregateError(
        failed ? [failure, cleanupError] : [cleanupError],
        "Doctor allocation cleanup failed",
        { cause: cleanupError },
      );
    }
    if (failed) throw failure;
  };
  const containers = new Map<string, ProbeLease>();
  const acquireContainer = async (container: string): Promise<ProbeLease> => {
    for (;;) {
      const existing = containers.get(container);
      if (existing?.cleanup) {
        await existing.cleanup;
        continue;
      }
      const lease = existing ?? { users: 0 };
      lease.users++;
      containers.set(container, lease);
      return lease;
    }
  };
  const releaseContainer = async (container: string, lease: ProbeLease): Promise<void> => {
    lease.users--;
    if (lease.users !== 0) return;
    lease.cleanup = Promise.resolve()
      .then(async () => {
        if (lease.created) {
          const data = await executeWorker("doctor-probe-worker.py", [
            JSON.stringify({ operation: "remove-container", ...lease.created }),
          ]);
          if (data !== null)
            throw new SshBackendError("PROBE_CLEANUP_FAILED", root.source, "unknown");
        }
      })
      .finally(() => {
        if (containers.get(container) === lease) containers.delete(container);
      });
    await lease.cleanup;
  };
  return {
    source: root.source,
    platform: "linux",
    toolPaths,
    probeCapture: (requestSignal) =>
      probeSshCapture({ ...backend.target, workspace: root.path }, root.source, requestSignal),
    async probeBrowser(requestSignal) {
      await probeSshBrowser(
        { ...backend.target, workspace: root.path },
        root.source,
        requestSignal,
      );
      return { ok: true, detail: "Target Playwright and Chromium started without navigation" };
    },
    async files(requestSignal) {
      const data = await executeWorker("doctor-inventory-worker.py", [root.path], requestSignal);
      if (!Value.Check(Type.Array(Type.String()), data))
        throw new SshBackendError(
          typeof data === "object" &&
            data !== null &&
            "error" in data &&
            data.error === "BYTE_LIMIT"
            ? "BYTE_LIMIT"
            : "INVENTORY_FAILED",
          root.source,
          "not-applied",
        );
      return data.map((name) => {
        const file = path.posix.resolve(root.path, name);
        if (path.posix.isAbsolute(name) || !(file.startsWith(`${root.path}/`) || root.path === "/"))
          throw new SshBackendError("INVALID_RESPONSE", root.source, "not-applied");
        return remoteLocation(root.target, file).source;
      });
    },
    async readText(resource, requestSignal) {
      try {
        const snapshot = await backend.read(resolve(resource), { signal: requestSignal });
        const content = snapshot.bytes.toString("utf8");
        snapshots.set(resource, { content, version: snapshot.version });
        return content;
      } catch (error) {
        if (error instanceof SshBackendError && error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async writeText(resource, content, previous, requestSignal) {
      const snapshot = snapshots.get(resource);
      if (previous !== undefined && (!snapshot || snapshot.content !== previous))
        throw new SshBackendError("CONFLICT", resource, "not-applied");
      await backend.write(
        resolve(resource),
        Buffer.from(content),
        previous === undefined ? null : (snapshot?.version ?? null),
        { signal: requestSignal },
      );
    },
    configPaths: (name, requestSignal) => layerAccess.paths(root.source, name, requestSignal),
    async exists(resource, requestSignal) {
      try {
        await backend.stat(resolve(resource), { signal: requestSignal });
        return true;
      } catch (error) {
        if (error instanceof SshBackendError && error.code === "ENOENT") return false;
        throw error;
      }
    },
    evidence: (recipes, requestSignal) =>
      inspectSshRecipeEvidence(backend, root.path, recipes, requestSignal),
    executableAvailability: (configs, requestSignal) =>
      sshProjectExecutableAvailability(backend, root.path, configs, requestSignal),
    run: (config, resource, requestSignal) =>
      processAccess.run(config, {
        projectRoot: root.source,
        filePath: resource,
        signal: requestSignal,
      }),
    async withProbeCopy(resource, use, requestSignal) {
      requestSignal?.throwIfAborted();
      const file = resolve(resource);
      const container = path.posix.join(path.posix.dirname(file), ".tmp");
      const lease = await acquireContainer(container);
      let probeData: Static<typeof probeSchema> | undefined;
      const name = path.posix.basename(file);
      const values = [];
      let failure: unknown;
      try {
        const previous = lease.allocation;
        const callbacks: { resolve?: () => void } = {};
        lease.allocation = new Promise<void>((resolveAllocation) => {
          callbacks.resolve = resolveAllocation;
        });
        const releaseAllocation = requiredValue(callbacks.resolve);
        try {
          await previous;
          requestSignal?.throwIfAborted();
          await allocateProbe(
            file,
            (data) => {
              probeData = data;
              if (data.containerCreated)
                lease.created = {
                  container,
                  device: data.containerDevice,
                  inode: data.containerInode,
                };
            },
            requestSignal,
          );
        } finally {
          releaseAllocation();
        }
        const probe = path.posix.join(requiredValue(probeData).directory, name);
        const original = await backend.lstat(file, { signal: requestSignal });
        await backend.copy(file, probe, original.revision, null, { signal: requestSignal });
        requestSignal?.throwIfAborted();
        values.push({ value: await use(remoteLocation(root.target, probe).source) });
      } catch (error) {
        failure = error;
      }
      const cleanupErrors: unknown[] = [];
      if (probeData) {
        try {
          const cleaned = await executeWorker("doctor-probe-worker.py", [
            JSON.stringify({ operation: "remove", ...probeData, name }),
          ]);
          if (cleaned !== null)
            throw new SshBackendError("PROBE_CLEANUP_FAILED", resource, "unknown");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await releaseContainer(container, lease);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0)
        throw new AggregateError(
          values.length === 0 ? [failure, ...cleanupErrors] : cleanupErrors,
          "Doctor probe cleanup failed",
          { cause: cleanupErrors[0] },
        );
      if (values.length === 0) throw failure;
      return requiredValue(values[0]).value;
    },
    start: (command, env, requestSignal) =>
      transport.start({ rootUri: root.source, command, env, signal: requestSignal }),
    toNativeUri: (resource) => transport.toServerUri(resource),
    fromNativeUri: (resource) => transport.fromServerUri(resource),
  };
}
