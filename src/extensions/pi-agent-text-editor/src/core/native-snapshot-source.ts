/** A completed Read/Search selection can join a native batch only for one local file. */
export function localSnapshotSource(
  value: string,
  targets: readonly { readonly source: string }[],
  snapshotResults: ReadonlySet<string>,
): string | undefined {
  if (!value.startsWith("SEARCH#") && !snapshotResults.has(value)) return undefined;
  if (targets.length !== 1) return undefined;
  const source = targets[0]?.source;
  if (source === undefined) return undefined;
  // A drive letter is a filesystem path, not a provider scheme.
  return /^[a-z][a-z\d+.-]*:/iu.test(source) && !/^[a-z]:[\\/]/iu.test(source) ? undefined : source;
}
