import { createHash } from "node:crypto";
import { resourceAccesses } from "./resource-access.ts";

/** Internal notification of a raw file snapshot used by an actual Read tool call. */
export const FILE_TEXT_READ_EVENT = "pi-agent-resource:file-text-read";
export interface FileTextRead {
  readonly keys: readonly string[];
  readonly digest: string;
  readonly complete: boolean;
}

export function fileTextDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Use the same canonical paths and aliases as the editor's resource scheduler. */
export async function fileTextKeys(source: string, cwd: string): Promise<readonly string[]> {
  return (await resourceAccesses(source, cwd, "read").catch(() => [])).map(
    ({ resource }) => resource,
  );
}
