import type { DeleteFileAccess } from "./delete-guard.js";

/** A native object captured without following its final symlink. */
export interface FileObjectEntry {
  readonly relativePath: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly revision: string;
  readonly identity: { readonly device: string; readonly inode: string };
  readonly mode: number;
  /** Original link bytes, encoded as Base64 rather than converted to text. */
  readonly link?: string;
}

/** Root first, followed by sorted descendants; an absent root has no entries. */
export interface FileObjectSnapshot {
  readonly path: string;
  readonly entries: readonly FileObjectEntry[];
}

/** Host-owned access to one native filesystem, never agent parameters. */
export interface FileTransferAccess extends DeleteFileAccess {
  readonly inspect: (source: string) => Promise<Omit<FileObjectEntry, "relativePath" | "link">>;
  /** Equal owners identify the same native filesystem path space. */
  readonly owner: string;
  readonly snapshot: (source: string, signal?: AbortSignal) => Promise<FileObjectSnapshot>;
}

/** A selected path and project on its own filesystem owner. */
export interface FileTransferEndpoint {
  readonly path: string;
  readonly cwd: string;
  readonly files: FileTransferAccess;
}

/** Approved snapshots; source removal still requires a fresh source check after publication. */
export interface FileTransferGuard {
  readonly source: FileObjectSnapshot;
  readonly target: FileObjectSnapshot;
  readonly sourceKind: "file" | "directory" | "symlink";
  readonly verifySource: () => Promise<void>;
}
