import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResourceAccess } from "./resource-scheduler.js";

/** Identify file aliases (including hard links) or an owner's canonical protocol source. */
export async function resourceAccesses(
  source: string,
  cwd: string,
  mode: ResourceAccess["mode"],
): Promise<readonly ResourceAccess[]> {
  if (
    /^[a-z][a-z\d+.-]*:/iu.test(source) &&
    !/^[a-z]:[\\/]/iu.test(source) &&
    !source.startsWith("file:")
  ) {
    return [{ resource: source, mode }];
  }
  const file = path.resolve(cwd, source.startsWith("file:") ? fileURLToPath(source) : source);
  const [resolved, metadata] = await Promise.allSettled([
    realpath(file),
    stat(file, { bigint: true }),
  ]);
  let canonical: string;
  if (resolved.status === "fulfilled") canonical = resolved.value;
  else {
    const error: unknown = resolved.reason;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) canonical = file;
    else {
      const parents = await resourceAccesses(parent, cwd, mode);
      const canonicalParent = parents.find((access) => access.resource.startsWith("file:"));
      canonical = path.join(canonicalParent?.resource.slice(5) ?? parent, path.basename(file));
    }
  }
  const normalized = canonical.split(path.sep).join("/");
  const group = `file:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
  const result: ResourceAccess[] = [{ resource: group, group, mode }];
  if (metadata.status === "fulfilled") {
    const info = metadata.value;
    if (info.isDirectory()) result[0] = { resource: group, group, mode, recursive: true };
    if (info.ino !== 0n)
      result.push({
        resource: `inode:${info.dev}:${info.ino}`,
        group,
        mode,
        recursive: info.isDirectory(),
      });
  } else {
    const error: unknown = metadata.reason;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  return result;
}
