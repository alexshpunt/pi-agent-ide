import { isExecutableAvailable } from "pi-agent-doctor/api/executable";

/** Default ElixirLS adapter command on a native Windows SSH target. */
export const WINDOWS_SSH_ELIXIR_DEBUG_COMMAND = "debug_adapter.bat";
export const WINDOWS_SSH_JS_DEBUG_PATH = ".pi/debug-adapters/js-debug/src/dapDebugServer.js";
/** Target project defaults for managed Node-based adapters on Windows SSH. */
export const WINDOWS_SSH_PHP_DEBUG_PATH = ".pi/debug-adapters/php-debug/extension/out/phpDebug.js";
export const WINDOWS_SSH_LUA_DEBUG_PATH =
  ".pi/debug-adapters/lua-debug/extension/extension/debugAdapter.js";

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
  available: (command: string) => Promise<boolean> = (command) =>
    isExecutableAvailable(command, cwd, env),
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
    if (await available(candidate.command)) return candidate;
  }
  return candidates[0] as DebuggerRuntimeCommand;
}
