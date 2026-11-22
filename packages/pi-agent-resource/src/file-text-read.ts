import { createHash } from "node:crypto";
import type { ResultRange } from "./result-targets.ts";
import { resourceAccesses } from "./resource-access.ts";

/** Internal notification of a raw file snapshot used by an actual Read tool call. */
export const FILE_TEXT_READ_EVENT = "pi-agent-resource:file-text-read";
/** The snapshot and the portions a Read call exposed for its resource keys. */
export interface FileTextRead {
  readonly keys: readonly string[];
  readonly digest: string;
  readonly complete: boolean;
  /** Exact source bytes shown to the caller, never the resolver’s hidden text. */
  readonly visible?: FileTextVisibility;
}

/** A nested tool returned these file ranges to its caller. */
export const FILE_TEXT_VISIBLE_EVENT = "pi-agent-resource:file-text-visible";
/** A snapshot with ranges of text shown from it. */
export interface FileTextVisibility {
  readonly content: string;
  readonly ranges: readonly ResultRange[];
}

/** Shown ranges associated with canonical file keys. */
export interface FileTextVisible extends FileTextVisibility {
  readonly keys: readonly string[];
}

/** Shown ranges associated with a file source. */
export interface FileTextWindow extends FileTextVisibility {
  readonly source: string;
}

type TextBlock = { readonly type: "text"; readonly text: string };

// Keep source snapshots off the serialized tool result.
const windowsByBlock = new WeakMap<object, { text: string; windows: readonly FileTextWindow[] }>();

/** Associate source ranges with the original readable block without serializing snapshots. */
export function attachFileTextWindows(block: TextBlock, windows: readonly FileTextWindow[]): void {
  if (windows.length > 0) windowsByBlock.set(block, { text: block.text, windows });
}

/** Get the ranges carried by a block whose text has not changed. */
function fileTextWindows(block: { readonly type: string }): readonly FileTextWindow[] {
  const entry = windowsByBlock.get(block);
  return entry !== undefined && "text" in block && block.text === entry.text ? entry.windows : [];
}

/** Consume the delivered windows without retaining snapshots for the lifetime of the message. */
export function takeFileTextWindows(block: { readonly type: string }): readonly FileTextWindow[] {
  const windows = fileTextWindows(block);
  windowsByBlock.delete(block);
  return windows;
}

/** Preserve a window only if a rewritten result kept its entire original text block. */
export function retainFileTextWindows(
  from: readonly { readonly type: string }[],
  to: TextBlock,
): TextBlock {
  attachFileTextWindows(
    to,
    from.flatMap((block) =>
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string" &&
      to.text.includes(block.text)
        ? fileTextWindows(block)
        : [],
    ),
  );
  return to;
}

/** Hash a snapshot for the whole-file write guard. */
export function fileTextDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Use the same canonical paths and aliases as the editor's resource scheduler. */
export async function fileTextKeys(source: string, cwd: string): Promise<readonly string[]> {
  return (await resourceAccesses(source, cwd, "read").catch(() => [])).map(
    ({ resource }) => resource,
  );
}
