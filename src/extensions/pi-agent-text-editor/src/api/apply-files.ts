import type { ResourceResolverContext } from "pi-agent-resource";

/** Owner-held disk snapshot. Release is idempotent and removes only its owned backup. */
export interface ApplyFileBackup {
  readonly sha256: string;
  readonly release: () => Promise<void>;
}

/** Original contents kept by an Apply checkpoint for compensation and undo. */
export interface ApplyFileState {
  readonly path: string;
  readonly existed: boolean;
  readonly bytes?: Uint8Array;
  /** Opaque owner capability instead of an in-memory byte snapshot. */
  readonly backup?: ApplyFileBackup;
}

/** File plan used for preflight and guarded effects; paths are not yet normalized. */
export type ApplyFileOperation =
  | { readonly kind: "create"; readonly path: string; readonly content: string }
  | {
      readonly kind: "delete" | "copy" | "move";
      readonly path: string;
      readonly target?: string;
      readonly overwrite?: boolean;
    };

/** Owning file access for one checkpoint, including every participating backend.
 * Reject unavailable owners rather than reading or writing a local URI-shaped path.
 * Restore is compensating recovery, not a distributed atomic operation.
 */
export interface ApplyFileAccess {
  /** Stable configured owner binding for canonical paths. Required for reloadable remote owners.
   * Return a different key when a target is rebound; reject missing owners without probing them.
   */
  readonly ownerKey?: (source: string) => string;
  readonly resolve: (cwd: string, source: string) => string;
  /** Use the current call signal; do not retain a canceled checkpoint signal in a receipt. */
  readonly capture: (source: string, signal?: AbortSignal) => Promise<ApplyFileState>;
  readonly readText: (source: string) => Promise<string>;
  /** Recovery may call without a signal so cancellation cannot interrupt compensation. */
  readonly restore: (state: ApplyFileState, signal?: AbortSignal) => Promise<void>;
  readonly validateFile: (operation: ApplyFileOperation, cwd: string) => Promise<void>;
  readonly performFile: (
    operation: Exclude<ApplyFileOperation, { kind: "create" }>,
    cwd: string,
  ) => Promise<void>;
}

/** Wrap existing access for owned resources; delegate only genuinely unowned sources.
 * Optional disposal runs after the core mutation queue and receipt cleanup finish.
 * It must be idempotent and retain failed cleanup ownership for another attempt.
 */
export type ApplyFileAccessProvider = ((
  previous: ApplyFileAccess,
  context: ResourceResolverContext,
) => ApplyFileAccess) & {
  readonly dispose?: () => Promise<void>;
};
