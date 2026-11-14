/** A Search selection can join a native batch only when one local file owns it. */
export function localSearchSource(
  value: string,
  targets: readonly { readonly source: string }[],
  searchResults: ReadonlySet<string>,
): string | undefined {
  if (!value.startsWith("SEARCH#") && !searchResults.has(value)) return undefined;
  if (targets.length !== 1) return undefined;
  const source = targets[0]?.source;
  if (source === undefined) return undefined;
  // A drive letter is a filesystem path, not a provider scheme.
  return /^[a-z][a-z\d+.-]*:/iu.test(source) && !/^[a-z]:[\\/]/iu.test(source) ? undefined : source;
}
