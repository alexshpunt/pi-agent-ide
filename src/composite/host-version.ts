/** Rejects older or unknown hosts before registering IDE capabilities. Star peers describe host ownership, not compatibility. */
export function assertSupportedHost(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (
    match === null ||
    compareVersion(match, [0, 99, 1]) < 0 ||
    isPrereleaseOf(match, [0, 99, 1])
  ) {
    throw new Error(
      `Pi Agent IDE requires Pi 0.99.1 or newer; this host is ${version}. Update Pi before loading the extension.`,
    );
  }
}

/**
 * Pi 1.3.0 and newer restore a resumed session's tools from its transcript and apply defaultTools
 * and CLI `+name`/`-name` selections before extensions start, so the IDE must not reapply them.
 */
export function hostOwnsToolLoadout(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/u.exec(version);
  return (
    match !== null && compareVersion(match, [1, 3, 0]) >= 0 && !isPrereleaseOf(match, [1, 3, 0])
  );
}

function compareVersion(match: RegExpExecArray, target: readonly number[]): number {
  return (
    match
      .slice(1, 4)
      .map((part, index) => Number(part) - (target[index] ?? 0))
      .find((part) => part !== 0) ?? 0
  );
}

function isPrereleaseOf(match: RegExpExecArray, target: readonly number[]): boolean {
  return compareVersion(match, target) === 0 && match[4] !== undefined;
}
