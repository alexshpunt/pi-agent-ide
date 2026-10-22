import { createTextDocument } from "pi-agent-text";
import type { FileOperation, FileOperationInput } from "#src/api/file-operations.js";
import type {
  TextMutationGuardContext,
  TextMutationGuardRegistration,
  TextMutationPlanResource,
} from "#src/api/mutation-guard.js";

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

/** Run the mutation policies over whole-file replacements; missing bytes after remove the file. */
export async function guardFileChanges(
  changes: readonly { readonly before: FileGuardSnapshot; readonly after?: Uint8Array }[],
  participants: readonly FileGuardSnapshot[],
  context: TextMutationGuardContext,
  read: (source: string) => Promise<FileGuardSnapshot>,
  guards: readonly TextMutationGuardRegistration[],
): Promise<void> {
  const resources = changes.map((change) => planResource(change.before, change.after));
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
