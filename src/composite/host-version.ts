/** Rejects older or unknown hosts before registering IDE capabilities. Star peers describe host ownership, not compatibility. */
export function assertSupportedHost(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  const minimum = [0, 99, 1];
  const parts = match?.slice(1, 4).map(Number);
  const difference =
    parts?.map((part, index) => part - (minimum[index] ?? 0)).find((part) => part !== 0) ?? 0;
  if (match === null || difference < 0 || (difference === 0 && match[4] !== undefined)) {
    throw new Error(
      `Pi Agent IDE requires Pi 0.99.1 or newer; this host is ${version}. Update Pi before loading the extension.`,
    );
  }
}
