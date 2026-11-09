import path from "node:path";

/** The operating system family of an SSH target. It selects path rules and remote workers. */
export type SshTargetOs = "linux" | "windows";

/** A file identity in one configured SSH target.
 * Paths are POSIX-shaped on every target. A Windows path keeps its drive as the first
 * segment (`/C:/Users/name`), so POSIX path operations stay valid; workers convert it
 * to the native form at the target boundary.
 */
export interface RemoteLocation {
  readonly target: string;
  readonly path: string;
  readonly source: string;
}

const windowsDrivePath = /^\/[A-Z]:(?:\/|$)/u;

/** Report whether a canonical path is rooted at a Windows drive. */
export function isWindowsRemotePath(filePath: string): boolean {
  return windowsDrivePath.test(filePath);
}

/** Build a canonical reference without treating filename characters as URI selectors.
 * With `os: "windows"`, drive paths in `C:/x`, `C:\x` or `/c:/x` form become `/C:/x`;
 * other Windows path forms are rejected.
 */
export function remoteLocation(
  target: string,
  filePath: string,
  os: SshTargetOs = "linux",
): RemoteLocation {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(target))
    throw new TypeError(
      "SSH target IDs must contain lowercase letters, digits, underscores or hyphens",
    );
  if (filePath.includes("\0")) throw new TypeError("Remote paths must contain no NUL characters");
  const normalized = os === "windows" ? windowsPath(filePath) : posixPath(filePath);
  // `:` is a valid URI path character; keeping it readable shows drives as `ssh://host/C:/x`.
  const encoded = normalized
    .split("/")
    .map((name) => encodeURIComponent(name).replaceAll("%3A", ":"))
    .join("/");
  return { target, path: normalized, source: `ssh://${target}${encoded}` };
}

function posixPath(filePath: string): string {
  if (!filePath.startsWith("/")) throw new TypeError("Remote paths must be absolute");
  return path.posix.normalize(filePath);
}

function windowsPath(filePath: string): string {
  const slashed = filePath.replaceAll("\\", "/");
  const match = /^\/?(?<drive>[A-Za-z]):(?<rest>\/.*)?$/u.exec(slashed);
  if (!match?.groups?.drive)
    throw new TypeError(
      "Windows remote paths must start with a drive, such as C:/Users; UNC and drive-relative paths are not supported",
    );
  // Normalizing below the drive keeps parent segments from leaving the drive root.
  return `/${match.groups.drive.toUpperCase()}:${path.posix.normalize(match.groups.rest ?? "/")}`;
}

/** Resolve explicit SSH references or ordinary paths relative to a remote workspace.
 * `osOf` names each configured target's OS; unknown targets use Linux rules.
 */
export function resolveRemoteLocation(
  source: string,
  cwd?: string,
  osOf: (target: string) => SshTargetOs | undefined = () => undefined,
): RemoteLocation | undefined {
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
    return remoteLocation(uri.hostname, decodeURIComponent(uri.pathname), osOf(uri.hostname));
  }
  if (!cwd?.startsWith("ssh:")) return undefined;
  const workspace = resolveRemoteLocation(cwd, undefined, osOf);
  if (!workspace) throw new TypeError("Invalid remote workspace");
  const os = osOf(workspace.target);
  // On Windows a one-letter prefix is a drive, not a URI scheme.
  if (os === "windows" && /^[A-Za-z]:/u.test(source))
    return remoteLocation(workspace.target, source, "windows");
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(source)) return undefined;
  if (os === "windows") return resolveWindowsPath(workspace, source);
  return remoteLocation(workspace.target, path.posix.resolve(workspace.path, source));
}

function resolveWindowsPath(workspace: RemoteLocation, source: string): RemoteLocation {
  const slashed = source.replaceAll("\\", "/");
  if (slashed.startsWith("//"))
    throw new TypeError("UNC paths are not supported on Windows SSH targets");
  // Resolve below the drive, so neither a rooted path nor parent segments leave it.
  const drive = workspace.path.slice(0, 3);
  const resolved = `${drive}${path.posix.resolve(workspace.path.slice(3) || "/", slashed)}`;
  return remoteLocation(workspace.target, resolved, "windows");
}
