const flags = new Set([
  "--help",
  "--list",
  "--list-connectors",
  "--check",
  "--record-contracts",
  "--preflight",
  "--run",
  "--tui",
  "--tui-history",
  "--dedicated-auth",
]);
const options = new Set([
  "--model",
  "--case",
  "--mode",
  "--attempts",
  "--concurrency",
  "--timeout",
  "--results",
  "--pi",
  "--auth-dir",
  "--connector",
  "--connector-root",
  "--claude-state",
  "--claude-executable",
]);

export function parseArguments(rawArgs: string[]) {
  const args = rawArgs.filter((arg) => arg !== "--");
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (flags.has(arg)) continue;
    if (!options.has(arg) || !args[index + 1] || args[index + 1]?.startsWith("--"))
      throw Error(`Unknown or incomplete option: ${arg}`);
    if (seen.has(arg)) throw Error(`Repeated option: ${arg}`);
    seen.add(arg);
    index++;
  }
  const value = (flag: string, fallback?: string): string | undefined => {
    const index = args.indexOf(flag);
    return index < 0 ? fallback : args[index + 1];
  };
  return { args, value };
}
