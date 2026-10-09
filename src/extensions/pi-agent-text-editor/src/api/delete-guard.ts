/** A whole object removed from this path by Delete or directory/symlink Move, never a text selection. */
export interface BeforeDeleteEvent {
  /** Absolute path supplied by the caller. */
  readonly path: string;
  /** Absolute identity with parent symlinks resolved, but not the final symlink. */
  readonly resolvedPath: string;
  readonly cwd: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly recursive: boolean;
  readonly signal?: AbortSignal;
}

/** A fail-closed policy. Throwing or denying prevents removal. */
export interface DeleteGuardRegistration {
  readonly id: string;
  readonly guard: (
    event: BeforeDeleteEvent,
  ) =>
    | { readonly decision: "allow" }
    | { readonly decision: "deny"; readonly reason: string }
    | Promise<
        { readonly decision: "allow" } | { readonly decision: "deny"; readonly reason: string }
      >;
}
