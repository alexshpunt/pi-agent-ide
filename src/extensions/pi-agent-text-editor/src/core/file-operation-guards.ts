import path from "node:path";
import { createTextDocument } from "pi-agent-text";
import type { FileObjectSnapshot, FileTransferEndpoint } from "#src/api/file-transfers.ts";
import type { FileOperation, FileOperationInput } from "#src/api/file-operations.ts";
import type {
  TextMutationGuardContext,
  TextMutationGuardRegistration,
  TextMutationPlanResource,
} from "#src/api/mutation-guard.ts";

/** A canonical, read-only whole-file snapshot. Missing bytes mean the file does not exist. */
export interface FileGuardSnapshot {
  readonly source: string;
  readonly bytes?: Uint8Array;
}

/** Run the existing mutation policies over every modified file, then reject changed participants. */
export async function guardFileOperation(
  operation: FileOperation,
  input: FileOperationInput,
  context: TextMutationGuardContext,
  read: (source: string) => Promise<FileGuardSnapshot>,
  guards: readonly TextMutationGuardRegistration[],
): Promise<void> {
  if (guards.length === 0) return;
  context.signal?.throwIfAborted();
  const source = await read(input.path);
  const target = input.target === undefined ? undefined : await read(input.target);
  await guardFileChanges(
    [
      ...(operation === "copy" ? [] : [{ before: source }]),
      ...(target === undefined ? [] : [{ before: target, after: source.bytes }]),
    ],
    [source, ...(target === undefined ? [] : [target])],
    context,
    read,
    guards,
  );
}

export interface DirectoryTransferPlan {
  readonly operation: "copy" | "move";
  readonly source: FileTransferEndpoint;
  readonly target: FileTransferEndpoint;
  readonly sourceSnapshot: FileObjectSnapshot;
  readonly targetSnapshot: FileObjectSnapshot;
  readonly caseRename: boolean;
}

/** Use the native tree inspection, reading only entries known to be regular files. */
export async function guardDirectoryTransfer(
  plan: DirectoryTransferPlan,
  context: TextMutationGuardContext,
  read: (source: string) => Promise<FileGuardSnapshot>,
  guards: readonly TextMutationGuardRegistration[],
): Promise<void> {
  if (guards.length === 0) return;
  const relativeKey = (relative: string) =>
    plan.target.files.caseInsensitive ? relative.toLowerCase() : relative;
  const ownerSource = (
    endpoint: FileTransferEndpoint,
    snapshot: FileObjectSnapshot,
    relative: string,
  ) => {
    const paths = endpoint.files.pathStyle === "native" ? path : path.posix;
    const parts = relative === "" ? [] : relative.split("/");
    if (paths.sep === "\\" && parts.some((part) => part.includes("\\") || part.includes(":")))
      throw Object.assign(new Error("Invalid transfer path for this filesystem"), {
        code: "INVALID_TARGET",
        effect: "not-applied",
      });
    return endpoint.files.source(paths.join(snapshot.path, ...parts));
  };
  const existing = async (source: string) => {
    context.signal?.throwIfAborted();
    const snapshot = await read(source);
    if (snapshot.bytes === undefined)
      throw Object.assign(new Error(`Transfer file disappeared during preflight: ${source}`), {
        code: "TRANSFER_TARGET_CHANGED",
        effect: "not-applied",
      });
    return { source, bytes: snapshot.bytes };
  };
  const targetEntries = new Map(
    plan.targetSnapshot.entries.map((entry) => [relativeKey(entry.relativePath), entry] as const),
  );
  const written = new Set<string>();
  const resources: TextMutationPlanResource[] = [];
  for (const entry of plan.sourceSnapshot.entries) {
    if (entry.kind !== "file") continue;
    const previous = targetEntries.get(relativeKey(entry.relativePath));
    const source = await existing(
      ownerSource(plan.source, plan.sourceSnapshot, entry.relativePath),
    );
    const target = ownerSource(plan.target, plan.targetSnapshot, entry.relativePath);
    const before =
      previous?.kind === "file"
        ? await existing(ownerSource(plan.target, plan.targetSnapshot, previous.relativePath))
        : undefined;
    if (plan.operation === "move") resources.push(planResource(source, undefined));
    resources.push(planResource({ source: target, bytes: before?.bytes }, source.bytes));
    written.add(relativeKey(entry.relativePath));
  }
  if (plan.operation === "move" && !plan.caseRename) {
    for (const entry of plan.targetSnapshot.entries) {
      if (entry.kind !== "file" || written.has(relativeKey(entry.relativePath))) continue;
      const before = await existing(
        ownerSource(plan.target, plan.targetSnapshot, entry.relativePath),
      );
      resources.push(planResource(before, undefined));
    }
  }
  if (resources.length > 0) await runFileGuards(resources, context, guards);
  // prepareObjectTransfer rechecks both complete tree snapshots after the hook returns.
}

/** Run the mutation policies over whole-file replacements; missing bytes after remove the file. */
export async function guardFileChanges(
  changes: readonly { readonly before: FileGuardSnapshot; readonly after?: Uint8Array }[],
  participants: readonly FileGuardSnapshot[],
  context: TextMutationGuardContext,
  read: (source: string) => Promise<FileGuardSnapshot>,
  guards: readonly TextMutationGuardRegistration[],
): Promise<void> {
  const resources = changes.map((change) => planResource(change.before, change.after));
  await runFileGuards(resources, context, guards);
  for (const snapshot of participants) {
    const current = await read(snapshot.source);
    if (current.source !== snapshot.source || !sameBytes(current.bytes, snapshot.bytes))
      throw Object.assign(new Error(`File changed during its mutation guard: ${snapshot.source}`), {
        code: "CONFLICT",
        effect: "not-applied",
      });
  }
  context.signal?.throwIfAborted();
}

async function runFileGuards(
  resources: readonly TextMutationPlanResource[],
  context: TextMutationGuardContext,
  guards: readonly TextMutationGuardRegistration[],
): Promise<void> {
  for (const registration of guards) {
    context.signal?.throwIfAborted();
    const result = await registration.guard({ resources }, context);
    if (result.kind === "rejected")
      throw Object.assign(new Error(result.rejection.message), {
        code: result.rejection.code,
        effect: "not-applied",
      });
  }
  context.signal?.throwIfAborted();
}

function planResource(
  before: FileGuardSnapshot,
  afterBytes: Uint8Array | undefined,
): TextMutationPlanResource {
  const beforeBytes = before.bytes ?? new Uint8Array();
  const after = afterBytes ?? new Uint8Array();
  const decode = (bytes: Uint8Array): string | undefined => {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return undefined;
    }
  };
  const beforeText = decode(beforeBytes);
  const afterText = decode(after);
  const binary = beforeText === undefined || afterText === undefined;
  return {
    source: before.source,
    existed: before.bytes !== undefined,
    deleted: afterBytes === undefined,
    before: createTextDocument(before.source, binary ? "" : beforeText),
    after: createTextDocument(before.source, binary ? "" : afterText),
    changes: [],
    ...(binary ? { binary: { before: beforeBytes.slice(), after: after.slice() } } : {}),
  };
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return left === undefined || right === undefined
    ? left === right
    : Buffer.from(left).equals(Buffer.from(right));
}
