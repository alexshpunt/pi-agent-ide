import path from "node:path";

/** A file identity in one configured SSH target. Paths use Linux, not host, rules. */
export interface RemoteLocation {
  readonly target: string;
  readonly path: string;
  readonly source: string;
}

/** Build a canonical reference without treating filename characters as URI selectors. */
export function remoteLocation(target: string, filePath: string): RemoteLocation {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(target))
    throw new TypeError(
      "SSH target IDs must contain lowercase letters, digits, underscores or hyphens",
    );
  if (!filePath.startsWith("/") || filePath.includes("\0"))
    throw new TypeError("Remote paths must be absolute and contain no NUL characters");
  const normalized = path.posix.normalize(filePath);
  const encoded = normalized.split("/").map(encodeURIComponent).join("/");
  return { target, path: normalized, source: `ssh://${target}${encoded}` };
}

/** Resolve explicit SSH references or ordinary paths relative to a remote workspace. */
export function resolveRemoteLocation(source: string, cwd?: string): RemoteLocation | undefined {
  if (source.startsWith("ssh:")) {
    const uri = new URL(source);
    if (
      !source.startsWith("ssh://") ||
      !uri.hostname ||
      uri.username ||
      uri.password ||
      uri.port ||
      uri.search ||
      uri.hash ||
      source.includes("?") ||
      source.includes("#")
    )
      throw new TypeError(
        "SSH references require a configured target and an absolute path, without credentials or selectors",
      );
    return remoteLocation(uri.hostname, decodeURIComponent(uri.pathname));
  }
  if (!cwd?.startsWith("ssh:") || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(source)) return undefined;
  const workspace = resolveRemoteLocation(cwd);
  if (!workspace) throw new TypeError("Invalid remote workspace");
  return remoteLocation(workspace.target, path.posix.resolve(workspace.path, source));
}
