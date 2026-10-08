/** A whole object removed from this path by Delete or directory/symlink Move, never a text selection. */
export interface BeforeDeleteEvent {
  /** Absolute requested path, or a canonical SSH URI for a target-owned object. */
  readonly path: string;
  /** Same owner, with parent symlinks resolved but not the final symlink. */
  readonly resolvedPath: string;
  /** Selected project directory on that owner, never a foreign controller directory. */
  readonly cwd: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly recursive: boolean;
  readonly signal?: AbortSignal;
}

/** Native file access for whole-object safety checks on the selected filesystem.
 * Paths passed to these methods are native target paths, never controller paths.
 */
export interface DeleteFileAccess {
  /** Omitted means POSIX target paths; native uses the controller platform's path syntax. */
  readonly pathStyle?: "posix" | "native";
  readonly realpath: (source: string) => Promise<string>;
  readonly inspect: (source: string) => Promise<{
    readonly kind: "file" | "directory" | "symlink" | "other";
    readonly revision: string;
  }>;
  readonly read: (source: string) => Promise<string>;
  readonly git: (cwd: string, args: string[], signal?: AbortSignal) => Promise<string>;
  /** Convert a native path into the canonical owner used in hooks and dialogs. */
  readonly source: (nativePath: string) => string;
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
