/** Keep the existing flags and accept one explicit SSH project; no source keeps local cwd. */
export function parseDoctorArguments(
  arguments_: string,
  cwd: string,
): { cwd: string; flags: ReadonlySet<string> } {
  const flags = new Set<string>();
  let source: string | undefined;
  for (const token of arguments_.trim().split(/\s+/u).filter(Boolean)) {
    if (["--apply", "--no-apply", "--agent"].includes(token)) flags.add(token);
    else if (token.startsWith("ssh://") && source === undefined) source = token;
    else
      throw new TypeError(
        "Use /pi-agent-ide-doctor [ssh://target/path] [--apply | --no-apply] [--agent]",
      );
  }
  if (flags.has("--apply") && flags.has("--no-apply"))
    throw new TypeError("Choose --apply or --no-apply, not both");
  return { cwd: source ?? cwd, flags };
}
