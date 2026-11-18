import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FILE_TEXT_READ_EVENT,
  fileTextDigest,
  fileTextKeys,
  type FileTextRead,
} from "pi-agent-resource";
import type { TextEditCompletion } from "#src/api/edit-completion.ts";
import type { TextResourceEditRequest } from "./text-editor-core.ts";

function isTextFile(resolvedBy: string, source: string): boolean {
  return resolvedBy === "filesystem" || source.startsWith("ssh://");
}

/** Observations belong to the session; internal planning or recovery reads cannot advance them. */
export class FileWriteObservations {
  readonly #digests = new Map<string, string>();

  constructor(pi: ExtensionAPI) {
    const unsubscribe = pi.events.on(FILE_TEXT_READ_EVENT, (event) => {
      const { keys, digest, complete } = event as FileTextRead;
      // A partial read can establish a baseline, but cannot authorize discarding unseen changes.
      for (const key of keys)
        if (complete || !this.#digests.has(key)) this.#digests.set(key, digest);
    });
    pi.on("session_start", () => this.#digests.clear());
    pi.on("session_shutdown", () => {
      unsubscribe();
      this.#digests.clear();
    });
  }

  matches(keys: readonly string[], digest: string | undefined): boolean {
    return keys.every((key) => !this.#digests.has(key) || this.#digests.get(key) === digest);
  }

  async saved(completion: TextEditCompletion): Promise<void> {
    if (!isTextFile(completion.resolvedBy, completion.resourceSource)) return;
    const keys = await fileTextKeys(completion.resourceSource, completion.cwd);
    const before = completion.beforePostProcessing ?? completion.before;
    const prior = completion.existed ? fileTextDigest(before.content) : undefined;
    // A targeted edit can succeed despite unseen peer changes. Don't bless that entire file.
    if (!this.matches(keys, prior)) return;
    const saved = fileTextDigest(completion.after.content);
    for (const key of keys) this.#digests.set(key, saved);
  }
}

const conflict =
  "File changed since this session read or wrote it. Read the whole current file and rebuild the content, or use a targeted edit.";

/** Pin even an unobserved file's first snapshot: a guarded-write retry cannot rebase a payload. */
export function guardWholeFileWrite(
  observations: FileWriteObservations | undefined,
  expectedContent: string | undefined,
): NonNullable<TextResourceEditRequest["checkSnapshot"]> {
  let first: { identity: string; digest: string | undefined } | undefined;
  return async ({ source, resolvedBy, existed, content }, cwd) => {
    if (expectedContent !== undefined && (!existed || expectedContent !== content)) return conflict;
    if (!isTextFile(resolvedBy, source)) return;
    const keys = await fileTextKeys(source, cwd);
    const identity = keys[0] ?? source;
    const digest = existed ? fileTextDigest(content) : undefined;
    if (first === undefined) {
      if (expectedContent === undefined && observations?.matches(keys, digest) === false)
        return conflict;
      first = { identity, digest };
    }
    return identity !== first.identity || digest !== first.digest ? conflict : undefined;
  };
}
