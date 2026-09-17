import { isExecutableAvailable } from "pi-agent-doctor/api/executable";

/** A debugger runtime command and arguments that precede adapter-specific arguments. */
export interface DebuggerRuntimeCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Resolve the first available Python 3 interpreter for debugger launch and Doctor probes. */
export async function resolvePythonDebuggerCommand(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<DebuggerRuntimeCommand> {
  if (env.PI_PYTHON_PATH !== undefined) return { command: env.PI_PYTHON_PATH, args: [] };
  const candidates: readonly DebuggerRuntimeCommand[] =
    platform === "win32"
      ? [
          { command: "python", args: [] },
          { command: "python3", args: [] },
          { command: "py", args: ["-3"] },
        ]
      : [
          { command: "python3", args: [] },
          { command: "python", args: [] },
        ];
  for (const candidate of candidates) {
    if (await isExecutableAvailable(candidate.command, cwd, env)) return candidate;
  }
  return candidates[0] as DebuggerRuntimeCommand;
}
