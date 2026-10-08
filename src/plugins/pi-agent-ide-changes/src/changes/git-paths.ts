import path from "node:path";

const scheme = /^[a-z][a-z0-9+.-]*:\/\//iu;

/** Resolve a Git source without turning a remote resource into a local path. */
export function resolveGitSource(source: string, cwd: string): string {
  if (scheme.test(source)) {
    const url = remoteUrl(source);
    return url.href;
  }
  if (!scheme.test(cwd)) return path.resolve(cwd, source);
  const url = remoteUrl(cwd);
  url.pathname = path.posix
    .resolve(decodeURIComponent(url.pathname), source)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return url.href;
}

/** Return a repository-relative path only when the source has the same owner. */
export function relativeGitSource(root: string, source: string): string | undefined {
  if (!scheme.test(root) && !scheme.test(source)) return path.relative(root, source);
  if (!scheme.test(root) || !scheme.test(source)) return undefined;
  const base = remoteUrl(root);
  const file = remoteUrl(source);
  if (base.host !== file.host) return undefined;
  return path.posix.relative(decodeURIComponent(base.pathname), decodeURIComponent(file.pathname));
}

/** Choose the source directory for Git discovery, including explicit remote files. */
export function gitSourceDirectory(source: string, cwd: string): string {
  const resolved = resolveGitSource(source, cwd);
  if (!scheme.test(resolved)) return path.dirname(resolved);
  const url = remoteUrl(resolved);
  url.pathname = path.posix
    .dirname(decodeURIComponent(url.pathname))
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return url.href;
}

function remoteUrl(source: string): URL {
  const url = new URL(source);
  if (url.protocol !== "ssh:" || url.username || url.password || url.port || url.search || url.hash)
    throw new Error(`Unsupported Git resource: ${source}`);
  return url;
}
