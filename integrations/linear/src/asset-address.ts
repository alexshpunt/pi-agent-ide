/** Validate the documented private storage host without accepting signed URLs or embedded credentials. */
export function checkedAssetUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LINEAR_INVALID_ASSET_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "uploads.linear.app" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/"
  )
    throw new Error("LINEAR_INVALID_ASSET_URL");
  return url.href;
}

/** An explicit workspace keeps native storage authorization separate from other URL providers. */
export function assetAddress(workspace: string, value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(workspace)) throw new Error("LINEAR_INVALID_WORKSPACE");
  return `linear://${workspace}/asset?url=${encodeURIComponent(checkedAssetUrl(value))}`;
}

/** Give plain private attachments an authorized Read link; other URLs keep their existing owner. */
export function attachmentReadUrl(workspace: string, url: string): string {
  try {
    return assetAddress(workspace, checkedAssetUrl(url));
  } catch {
    return url;
  }
}
/** Recognize only provider-issued private asset addresses, never arbitrary web URLs. */
export function parseAssetAddress(
  source: string,
): { source: string; workspace: string; url: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "linear:" || parsed.pathname !== "/asset") return undefined;
  const value = parsed.searchParams.get("url");
  if (
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash ||
    parsed.searchParams.size !== 1 ||
    value === null
  )
    throw new Error("LINEAR_INVALID_ASSET_URL");
  const url = checkedAssetUrl(value);
  return { source: assetAddress(parsed.hostname, url), workspace: parsed.hostname, url };
}
