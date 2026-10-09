import type { ResourceResolverContext } from "pi-agent-resource";
import type { BeforeDeleteEvent, DeleteFileAccess } from "./delete-guard.js";
import type { FileTransferEndpoint, FileTransferGuard } from "./file-transfers.js";

/** Whole-file operations, distinct from text-selection transfers and removal. */
export const fileOperations = ["delete", "move", "copy"] as const;
export type FileOperation = (typeof fileOperations)[number];

/** Original paths for an owning provider, before local path resolution.
 * Copy merges compatible directory trees; Move replaces compatible destinations.
 * Source links are preserved; destination links and same-object transfers are refused.
 */
export interface FileOperationInput {
  readonly path: string;
  readonly target?: string;
}

/** Explicit operation effect; unknown means a mutation may have happened.
 * Successful results are applied and name the canonical source and transfer target.
 */
export interface FileOperationResult {
  readonly kind: "file-operation";
  readonly operation: FileOperation;
  readonly ok: boolean;
  readonly effect: "applied" | "not-applied" | "unknown";
  readonly path?: string;
  readonly target?: string;
  /** Directories and links are not sent through text post-processing. */
  readonly sourceKind?: "file" | "directory" | "symlink";
  readonly error?: { readonly code: string; readonly message: string };
}

/** Safety policy supplied by the host before an owned provider mutates objects. */
export interface FileOperationPolicy {
  readonly prepare: (
    source: string,
    cwd: string,
    files: DeleteFileAccess,
  ) => Promise<BeforeDeleteEvent & { readonly revision: string }>;
  readonly prepareTransfer: (
    operation: "copy" | "move",
    source: FileTransferEndpoint,
    target: FileTransferEndpoint,
  ) => Promise<FileTransferGuard>;
}
/** Claim the operation, or return undefined without effects to leave it to another owner.
 * Reject owned failures rather than allowing local fallback. Preserve canonical paths
 * and explicit effects in returned results or thrown errors.
 */
export type FileOperationResolver = (
  operation: FileOperation,
  input: FileOperationInput,
  context: ResourceResolverContext,
  policy?: FileOperationPolicy,
) => Promise<FileOperationResult | undefined>;
