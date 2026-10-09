import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Fingerprint bounded, caller-owned input bytes and file identities; never follow symlinks. */
async function fingerprint(source, signal) {
  let bytes = 0;
  let files = 0;
  const hash = createHash("sha256");
  async function visit(file) {
    signal?.throwIfAborted();
    const stat = await lstat(file, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error("REA research inputs must not contain symlinks");
    hash.update(`${file}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}\0`);
    if (stat.isDirectory()) {
      if (++files > 512) throw new Error("REA input exceeds 512 entries");
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name));
    } else if (stat.isFile()) {
      bytes += Number(stat.size);
      if (++files > 512 || bytes > 32 * 1024 * 1024)
        throw new Error("REA input exceeds the research budget");
      hash.update(await readFile(file, { signal }));
    } else throw new Error("REA input must be regular files or directories");
  }
  await visit(source);
  signal?.throwIfAborted();
  return hash.digest("hex");
}

function evidenceRecord(value, operation) {
  if (
    !/^ev_[a-f0-9]{64}$/.test(value?.evidence_id ?? "") ||
    value.operation !== operation ||
    !value.normalized_result ||
    !value.subject ||
    !value.provider ||
    !Array.isArray(value.limitations)
  )
    throw new Error(`REA returned invalid ${operation} Evidence`);
  if (Buffer.byteLength(JSON.stringify(value)) > 20 * 1024 * 1024)
    throw new Error("REA Evidence exceeds 20 MiB");
  return value;
}

function project(evidence, session, identity, facet) {
  const result = evidence.normalized_result;
  const metadata = {
    session,
    evidence: evidence.evidence_id,
    parentEvidence: result.parent_evidence_id,
    operation: evidence.operation,
    authority: evidence.authority,
    subject: evidence.subject,
    provider: evidence.provider,
    server: identity,
    limitations: evidence.limitations,
  };
  const body =
    facet === "pseudocode"
      ? `Procedure: ${JSON.stringify(result.procedure)}\nCallers: ${JSON.stringify(result.callers)}\nCallees: ${JSON.stringify(result.callees)}\n\n${result.pseudocode}`
      : JSON.stringify(result, null, 2);
  if (facet === "pseudocode" && typeof result.pseudocode !== "string")
    throw new Error("REA pseudocode unavailable");
  const text = `REA static snapshot — not runtime proof. Read-only; text Select only.\n${JSON.stringify(metadata, null, 2)}\n\n${body}\n`;
  if (Buffer.byteLength(text) > 256 * 1024)
    throw new Error("REA text projection exceeds 256 KiB; no partial snapshot published");
  return text;
}

/** Own one lazy private connection and immutable text snapshots. Failure ends this owner; no silent retries. */
export class ReaOwner {
  #connect;
  #connection;
  #queue = Promise.resolve();
  #disposal;
  #closed = false;
  #lifetime = new AbortController();
  #session = randomUUID();
  #snapshots = new Map();
  #aliases = new Map();
  #nativeOpen = false;
  #config;

  constructor(config, connect) {
    this.#config = config;
    this.#connect = connect;
  }

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  #serial(operation) {
    const pending = this.#queue.then(operation);
    this.#queue = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }

  #assertOpen(signal) {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error("REA research session closed; retained sources expired");
  }

  /** Resolve configured aliases or exact retained URIs; analysis never runs for a guessed Evidence URI. */
  resolve(source, signal) {
    return this.#serial(async () => {
      this.#assertOpen(signal);
      if (this.#snapshots.has(source)) {
        const snapshot = this.#snapshots.get(source);
        await this.#verify(snapshot, signal);
        return snapshot;
      }
      const cached = this.#aliases.get(source);
      if (cached) {
        await this.#verify(cached, signal);
        return cached;
      }
      const native = /^rea:\/\/native\/([\w.$-]+)$/.exec(source);
      const application = source === "rea://application/summary";
      if (!native && !application)
        throw new Error(
          "Unknown or expired REA source; use a configured alias, not a guessed Evidence reference",
        );
      if (this.#snapshots.size >= 32)
        throw new Error("REA research snapshot budget reached; close this session");
      const input = native ? this.#config.binary : this.#config.application;
      if (!input) throw new Error("This REA input is not configured");
      const active = signal
        ? AbortSignal.any([signal, this.#lifetime.signal])
        : this.#lifetime.signal;
      try {
        const stamp = await fingerprint(input, active);
        const nativeDigest = native
          ? createHash("sha256")
              .update(await readFile(input, { signal: active }))
              .digest("hex")
          : undefined;
        this.#connection ??= await this.#connect(active);
        const call = (name, args) => this.#connection.call(name, args, active);
        let evidence;
        let facet;
        if (native) {
          if (!this.#nativeOpen) {
            await call("open_binary", { path: input, provider_id: "ghidra" });
            this.#nativeOpen = true;
          }
          evidence = evidenceRecord(
            await call("analyze_function", { procedure: native[1] }),
            "analyze_function",
          );
          if (evidence.subject.digest?.sha256 !== nativeDigest)
            throw new Error("REA native artifact digest mismatch");
          facet = "pseudocode";
        } else {
          const parent = evidenceRecord(
            await call("analyze_javascript_application", { input_path: input }),
            "analyze_javascript_application",
          );
          evidence = evidenceRecord(
            await call("inspect_analysis_view", {
              source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
              view: { kind: "summary" },
            }),
            "inspect_analysis_view",
          );
          if (evidence.normalized_result.parent_evidence_id !== parent.evidence_id)
            throw new Error("REA view parent Evidence mismatch");
          facet = "summary";
        }
        this.#assertOpen(active);
        if ((await fingerprint(input, active)) !== stamp)
          throw new Error("REA input changed during analysis");
        const snapshot = Object.freeze({
          source: `rea://${this.#session}/${evidence.evidence_id}/${facet}`,
          text: project(evidence, this.#session, this.#connection.identity, facet),
          input,
          stamp,
        });
        const previous = this.#snapshots.get(snapshot.source);
        if (previous && (previous.text !== snapshot.text || previous.stamp !== snapshot.stamp))
          throw new Error(
            "REA Evidence identity already belongs to a different immutable snapshot",
          );
        this.#snapshots.set(snapshot.source, snapshot);
        this.#aliases.set(source, snapshot);
        return snapshot;
      } catch (failure) {
        try {
          await this.#dispose();
        } catch (cleanup) {
          throw new AggregateError(
            [failure, cleanup],
            `${failure.message}; cleanup failed: ${cleanup.message}`,
            { cause: cleanup },
          );
        }
        throw failure;
      }
    });
  }

  async #verify(snapshot, signal) {
    this.#assertOpen(signal);
    if ((await fingerprint(snapshot.input, signal)) !== snapshot.stamp)
      throw new Error("REA input changed; retained authority expired");
    this.#assertOpen(signal);
  }

  /** Reread only an exact snapshot of this live owner; used by Read/Search/Select freshness checks. */
  read(source, signal) {
    return this.#serial(async () => {
      this.#assertOpen(signal);
      const snapshot = this.#snapshots.get(source);
      if (!snapshot) throw new Error("Unknown or expired REA snapshot");
      await this.#verify(snapshot, signal);
      return snapshot.text;
    });
  }

  #dispose() {
    if (this.#disposal) return this.#disposal;
    this.#closed = true;
    this.#snapshots.clear();
    this.#aliases.clear();
    this.#disposal = (async () => {
      if (!this.#connection) return;
      const failures = [];
      for (const action of [
        () => this.#connection.call("close_binary", {}, undefined),
        () => this.#connection.close(),
      ]) {
        try {
          await action();
        } catch (failure) {
          failures.push(failure);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, failures.map((failure) => failure.message).join("; "), {
          cause: failures[0],
        });
    })();
    return this.#disposal;
  }

  /** Invalidate authority immediately, cancel pending work, then close REA and its private transport. */
  close() {
    this.#closed = true;
    this.#lifetime.abort(new Error("REA research session closed"));
    return this.#serial(() => this.#dispose());
  }
}
