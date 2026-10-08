import { createHash } from "node:crypto";
import { ResourceError } from "pi-agent-resource";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { remoteLocation } from "./identity.js";
import type { SshProcessChannel, SshProcessContext } from "./ssh-channel.js";
import { sshWorkerProgram, validateSshTarget } from "./ssh-transport.js";

/** One explicitly configured host alias. Authentication stays in the user's OpenSSH environment. */
export interface SshTarget {
  readonly id: string;
  readonly host: string;
  readonly workspace: string;
  readonly configFile?: string;
}

/** The expected Git entry and HEAD used to guard one index publication. */
export interface SshGitIndexWrite {
  readonly repositoryPath: string;
  readonly mode: string;
  readonly text: string;
  readonly expectedHead: string;
  readonly expectedIndexText: string;
  readonly expectedIndexMode: string;
  /** False expects no stage-zero entry, not an empty blob. */
  readonly expectedIndexExists?: boolean;
  readonly expectedWorktreeText?: string;
}
/** Cancellation and total transport deadline for one operation. */
export interface BackendOperationContext {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** A transport-safe failure. Never retains raw SSH diagnostics or configuration paths. */
export class SshBackendError extends ResourceError {
  constructor(
    code: string,
    source: string,
    effect: "not-applied" | "applied" | "unknown",
    /** Preserve only another sanitized backend failure, never raw transport diagnostics. */
    options?: { readonly cause: SshBackendError },
  ) {
    super(code, source, effect, options);
    this.name = code === "CANCELLED" ? "AbortError" : "SshBackendError";
  }
}

const snapshotSchema = Type.Object({
  bytes: Type.String(),
  version: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});
const journalSchema = Type.Object({
  directory: Type.String(),
  path: Type.String(),
  revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  sourceRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});
const rangeSchema = Type.Object({
  revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  bytes: Type.String(),
  offset: Type.Integer({ minimum: 0 }),
  totalBytes: Type.Integer({ minimum: 0 }),
});
const entriesSchema = Type.Array(
  Type.Object({
    name: Type.String(),
    kind: Type.Union([
      Type.Literal("file"),
      Type.Literal("directory"),
      Type.Literal("symlink"),
      Type.Literal("other"),
    ]),
  }),
);
const statSchema = Type.Object({
  kind: Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("other")]),
  size: Type.Integer({ minimum: 0 }),
  mode: Type.Integer({ minimum: 0 }),
});
const lstatSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("file"),
    Type.Literal("directory"),
    Type.Literal("symlink"),
    Type.Literal("other"),
  ]),
  size: Type.Integer({ minimum: 0 }),
  mode: Type.Integer({ minimum: 0 }),
  links: Type.Integer({ minimum: 0 }),
  identity: Type.Object({
    device: Type.String({ pattern: "^[0-9]+$" }),
    inode: Type.String({ pattern: "^[0-9]+$" }),
  }),
  revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});
const replySchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), data: Type.Unknown() }),
  Type.Object({
    ok: Type.Literal(false),
    code: Type.String({ pattern: "^[A-Z][A-Z0-9_]*$" }),
    effect: Type.Union([
      Type.Literal("not-applied"),
      Type.Literal("applied"),
      Type.Literal("unknown"),
    ]),
  }),
]);
type Reply = Static<typeof replySchema>;

/** Short SSH operations with explicit snapshots; long-lived service channels are separate. */
export class SshBackend {
  readonly target: SshTarget;

  constructor(target: SshTarget) {
    validateSshTarget(target);
    this.target = { ...target };
  }

  /** Inspect remote type and permissions without downloading content. */
  async stat(filePath: string, context: BackendOperationContext = {}) {
    const data = await this.request({ operation: "stat", path: filePath }, false, context);
    this.checked(statSchema, data, filePath, false);
    return data;
  }
  /** Inspect the entry itself without following links or reading content.
   * Identity is target-scoped; revision covers metadata, not a guarded content snapshot.
   */
  async lstat(filePath: string, context: BackendOperationContext = {}) {
    const data = await this.request({ operation: "lstat", path: filePath }, false, context);
    this.checked(lstatSchema, data, filePath, false);
    return data;
  }
  /** Capture a guarded, disk-backed regular-file journal on this target.
   * Copies and hashes bounded chunks; file bytes never enter the JSON transport.
   * The caller owns the returned directory and must release it after use.
   */
  async captureJournal(filePath: string, context: BackendOperationContext = {}) {
    const data = await this.request({ operation: "journal", path: filePath }, false, context);
    this.checked(journalSchema, data, filePath, false);
    return data;
  }
  /** Remove only the snapshot and empty directory created by captureJournal. */
  async releaseJournal(directory: string, context: BackendOperationContext = {}): Promise<void> {
    const data = await this.request(
      { operation: "journal-release", path: directory },
      false,
      context,
    );
    this.checked(Type.Null(), data, directory, false);
  }
  /** Read bytes and a version covering content, file identity and metadata in one snapshot. */
  async read(filePath: string, context: BackendOperationContext = {}) {
    const data = await this.request({ operation: "read", path: filePath }, false, context);
    this.checked(snapshotSchema, data, filePath, false);
    return { bytes: Buffer.from(data.bytes, "base64"), version: data.version };
  }

  /** Read original bytes; revision fingerprints inode/metadata, not a guarded write snapshot. */
  async readRange(
    filePath: string,
    offset: number,
    limit: number,
    context: BackendOperationContext = {},
  ) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || limit < 0)
      throw new TypeError("Byte offset and limit must be safe integers; limit must be nonnegative");
    const data = await this.request(
      { operation: "range", path: filePath, offset, limit },
      false,
      context,
    );
    this.checked(rangeSchema, data, filePath, false);
    return {
      bytes: Buffer.from(data.bytes, "base64"),
      offset: data.offset,
      totalBytes: data.totalBytes,
      revision: data.revision,
    };
  }

  /** List directory entries without following symlinks or losing their names. */
  async list(directory: string, context: BackendOperationContext = {}) {
    const data = await this.request({ operation: "list", path: directory }, false, context);
    this.checked(entriesSchema, data, directory, false);
    return data;
  }

  /** Replace bytes after checking a snapshot version, or require absence with expected=null. */
  async write(
    filePath: string,
    bytes: Uint8Array,
    expected: string | null,
    context: BackendOperationContext = {},
  ): Promise<string> {
    const data = await this.request(
      {
        operation: "write",
        path: filePath,
        bytes: Buffer.from(bytes).toString("base64"),
        expected,
      },
      true,
      context,
    );
    this.checked(Type.String({ pattern: "^[a-f0-9]{64}$" }), data, filePath, true);
    return data;
  }

  /** Copy a regular file within this target without sending its bytes over SSH.
   * Require metadata revisions from lstat; null requires an absent destination.
   * Missing destination parents are created after preflight. IDE locks and a final revision
   * check do not provide CAS against external writers.
   */
  async copy(
    filePath: string,
    destination: string,
    sourceRevision: string,
    targetRevision: string | null,
    context: BackendOperationContext = {},
  ): Promise<void> {
    return this.copyEntry("copy", filePath, destination, sourceRevision, targetRevision, context);
  }

  /** Restore journal bytes while keeping an existing hard-linked destination inode.
   * Linked restoration is in-place, not atomic, and interruption can have an unknown effect.
   */
  async restoreJournal(
    filePath: string,
    destination: string,
    sourceRevision: string,
    targetRevision: string | null,
    context: BackendOperationContext = {},
  ): Promise<void> {
    return this.copyEntry(
      "restore",
      filePath,
      destination,
      sourceRevision,
      targetRevision,
      context,
    );
  }

  private async copyEntry(
    operation: "copy" | "restore",
    filePath: string,
    destination: string,
    sourceRevision: string,
    targetRevision: string | null,
    context: BackendOperationContext,
  ): Promise<void> {
    const data = await this.request(
      {
        operation,
        path: filePath,
        destination,
        sourceRevision,
        targetRevision,
      },
      true,
      context,
    );
    this.checked(Type.Null(), data, filePath, true);
  }
  /** Move a regular entry after metadata checks. Same-filesystem moves keep its inode.
   * Cross-filesystem moves copy then unlink; interruption can leave an unknown partial effect.
   * Missing destination parents are created after preflight. The final check is not external-writer CAS.
   */
  async move(
    filePath: string,
    destination: string,
    sourceRevision: string,
    targetRevision: string | null,
    context: BackendOperationContext = {},
  ): Promise<void> {
    const data = await this.request(
      {
        operation: "move",
        path: filePath,
        destination,
        sourceRevision,
        targetRevision,
      },
      true,
      context,
    );
    this.checked(Type.Null(), data, filePath, true);
  }

  /** Resolve a target-native path, requiring each followed entry to exist. */
  async realpath(filePath: string, context: BackendOperationContext = {}): Promise<string> {
    const data = await this.request({ operation: "realpath", path: filePath }, false, context);
    this.checked(Type.String({ minLength: 1 }), data, filePath, false);
    if (!data.startsWith("/"))
      throw new SshBackendError("INVALID_RESPONSE", filePath, "not-applied");
    return data;
  }

  /** Query target Git with inherited Git overrides removed and optional locks disabled. */
  async queryGit(
    cwd: string,
    args: string[],
    context: BackendOperationContext = {},
  ): Promise<string> {
    const data = await this.request({ operation: "git-query", path: cwd, args }, false, {
      ...context,
      timeoutMs: 5000,
    });
    this.checked(Type.String(), data, cwd, false);
    return data;
  }

  /** Remove one policy-approved object after its final identity check.
   * Recursive deletion never follows symlink entries. It has no rollback; failures
   * after removal starts have unknown effects. Call only after host deletion policy.
   */
  async removeObject(
    filePath: string,
    revision: string,
    context: BackendOperationContext = {},
  ): Promise<void> {
    const data = await this.request(
      { operation: "delete-object", path: filePath, revision },
      true,
      context,
    );
    this.checked(Type.Null(), data, filePath, true);
  }
  /** Remove the regular entry after an lstat metadata check, without downloading content. */
  async removeEntry(
    filePath: string,
    revision: string,
    context: BackendOperationContext = {},
  ): Promise<void> {
    const data = await this.request(
      { operation: "unlink", path: filePath, revision },
      true,
      context,
    );
    this.checked(Type.Null(), data, filePath, true);
  }
  /** Remove one regular file only when its current content still matches the snapshot. */
  async remove(
    filePath: string,
    expected: string,
    context: BackendOperationContext = {},
  ): Promise<void> {
    const data = await this.request(
      { operation: "remove", path: filePath, expected },
      true,
      context,
    );
    this.checked(Type.Null(), data, filePath, true);
  }

  /** Publish a private index under Git’s index lock after entry and HEAD checks.
   * Uncooperative external writers can still race the final check; lost replies remain unknown.
   */
  async writeGitIndex(
    cwd: string,
    update: SshGitIndexWrite,
    context: BackendOperationContext = {},
  ): Promise<void> {
    const bytes = Buffer.from(update.text, "utf8");
    if (bytes.length > 32 * 1024 * 1024)
      throw new SshBackendError(
        "CONTENT_LIMIT",
        remoteLocation(this.target.id, cwd).source,
        "not-applied",
      );
    const { text: _text, expectedIndexText, expectedWorktreeText, ...state } = update;
    const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    const data = await this.request(
      {
        operation: "gitIndex",
        path: cwd,
        ...state,
        bytes: bytes.toString("base64"),
        expectedIndexHash: digest(expectedIndexText),
        ...(expectedWorktreeText !== undefined && {
          expectedWorktreeHash: digest(expectedWorktreeText),
        }),
      },
      true,
      context,
    );
    this.checked(Type.Null(), data, cwd, true);
  }
  /** Execute exact argv in remote cwd and await owned native cleanup before returning.
   * Nonzero program exits are results; interrupted commands may already have changed files.
   */
  async execute(
    command: string,
    args: readonly string[],
    cwd: string,
    context: BackendOperationContext = {},
  ) {
    const { runOwnedSshCommand } = await import("./owned-command.js");
    return runOwnedSshCommand(
      { ...this.target, workspace: cwd },
      command,
      args,
      remoteLocation(this.target.id, cwd).source,
      {
        signal: context.signal,
        timeoutMs: context.timeoutMs ?? 30_000,
        maxBytes: 32 * 1024 * 1024,
        limitCode: "CONTENT_LIMIT",
        closeInput: true,
        effect: "unknown",
      },
    );
  }

  /** Open remote service stdio with ordered input, bounded buffers and owned-process cleanup. */
  async startProcess(
    command: string,
    args: readonly string[],
    cwd: string,
    context: SshProcessContext = {},
  ): Promise<SshProcessChannel> {
    const { startSshProcess } = await import("./ssh-channel.js");
    return startSshProcess(this.target, command, args, cwd, context);
  }

  private checked<T extends TSchema>(
    schema: T,
    value: unknown,
    filePath: string,
    mutation: boolean,
  ): asserts value is Static<T> {
    if (!Value.Check(schema, value))
      throw new SshBackendError(
        "INVALID_RESPONSE",
        remoteLocation(this.target.id, filePath).source,
        mutation ? "unknown" : "not-applied",
      );
  }

  private async request(
    input: Readonly<Record<string, unknown>>,
    mutation: boolean,
    context: BackendOperationContext,
  ): Promise<unknown> {
    const filePath =
      typeof input.path === "string"
        ? input.path
        : typeof input.cwd === "string"
          ? input.cwd
          : this.target.workspace;
    const source = remoteLocation(this.target.id, filePath).source;
    const deadline = context.timeoutMs ?? 30_000;
    if (!Number.isFinite(deadline) || deadline <= 0)
      throw new TypeError("SSH operation deadline must be positive");
    context.signal?.throwIfAborted();
    const { runOwnedSshCommand } = await import("./owned-command.js");
    const program = await sshWorkerProgram(new URL("./ssh-worker.py", import.meta.url));
    // Filesystem operands are absolute. A neutral existing cwd must not turn the workspace
    // into a sandbox or prevent creation beneath a missing parent.
    const result = await runOwnedSshCommand(
      { ...this.target, workspace: input.operation === "gitIndex" ? filePath : "/" },
      "python3",
      ["-c", program],
      source,
      {
        signal: context.signal,
        timeoutMs: deadline,
        maxBytes: 48 * 1024 * 1024,
        limitCode: "CONTENT_LIMIT",
        effect: mutation ? "unknown" : "not-applied",
        input: Buffer.from(JSON.stringify(input)),
      },
    );
    if (result.exitCode !== 0)
      throw new SshBackendError(
        "REMOTE_OPERATION_FAILED",
        source,
        mutation ? "unknown" : "not-applied",
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new SshBackendError("INVALID_RESPONSE", source, mutation ? "unknown" : "not-applied");
    }
    if (!isReply(parsed))
      throw new SshBackendError("INVALID_RESPONSE", source, mutation ? "unknown" : "not-applied");
    if (!parsed.ok) throw new SshBackendError(parsed.code, source, parsed.effect);
    return parsed.data;
  }
}

function isReply(value: unknown): value is Reply {
  return Value.Check(replySchema, value);
}
