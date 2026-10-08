import type { ResourceResolverContext } from "pi-agent-resource";
import type { FileDeletionPolicy } from "./delete-guard.js";

/** Whole-file operations, distinct from text-selection transfers and removal. */
export const fileOperations = ["delete", "move", "copy"] as const;
export type FileOperation = (typeof fileOperations)[number];

/** Original paths for an owning provider, before local path resolution.
 * Copy and Move replace existing regular destinations; reject symlinks and same-file transfers.
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
  readonly error?: { readonly code: string; readonly message: string };
}

/** Claim the operation, or return undefined without effects to leave it to another owner.
 * Reject owned failures rather than allowing local fallback. Preserve canonical paths
 * and explicit effects in returned results or thrown errors.
 */
export type FileOperationResolver = (
  operation: FileOperation,
  input: FileOperationInput,
  context: ResourceResolverContext,
  deletion?: FileDeletionPolicy,
) => Promise<FileOperationResult | undefined>;
