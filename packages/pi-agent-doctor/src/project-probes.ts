import { access } from "node:fs/promises";
import {
  isExecutableAvailable,
  probeExecutable,
  type ExecutableProbeResult,
} from "./executable.js";
import type { DoctorContext } from "./plugin-protocol.js";

/** Test a file on the selected owner without turning an access refusal into absence. */
export async function projectFileExists(context: DoctorContext, source: string): Promise<boolean> {
  context.signal?.throwIfAborted();
  if (context.workspace) return context.workspace.exists(source, context.signal);
  if (source.includes("://"))
    throw Object.assign(new Error("Doctor needs the file owner"), { code: "UNSUPPORTED_SOURCE" });
  try {
    await access(source);
    context.signal?.throwIfAborted();
    return true;
  } catch (error) {
    context.signal?.throwIfAborted();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

/** Start a short version check through the same owner as runtime execution. */
export async function probeProjectExecutable(
  context: DoctorContext,
  command: string,
  arguments_: readonly string[],
): Promise<ExecutableProbeResult> {
  context.signal?.throwIfAborted();
  if (!context.workspace) {
    const result = await probeExecutable(
      command,
      arguments_,
      context.cwd,
      context.env,
      context.signal,
    );
    context.signal?.throwIfAborted();
    return result;
  }
  const result = await context.workspace.run(
    { command: [command, ...arguments_], timeoutMs: 5_000 },
    context.cwd,
    context.signal,
  );
  context.signal?.throwIfAborted();
  const detail =
    (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/u)[0] ||
    `${command} exited with code ${String(result.exitCode)}`;
  return { ok: result.ok, detail };
}

/** Check a native command on the selected owner without starting it. */
export async function projectExecutableAvailable(
  context: DoctorContext,
  command: string,
): Promise<boolean> {
  context.signal?.throwIfAborted();
  if (!context.workspace)
    return isExecutableAvailable(command, context.cwd, context.env, context.signal);
  const values = await context.workspace.executableAvailability(
    [{ command: [command] }],
    context.signal,
  );
  context.signal?.throwIfAborted();
  if (values.length !== 1 || typeof values[0] !== "boolean")
    throw new TypeError("Invalid Doctor availability report");
  return values[0];
}
