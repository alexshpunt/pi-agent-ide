import spawn from "cross-spawn";

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

/** Common native project tool directories, in launch priority order. */
export function projectExecutableDirectories(cwd: string): readonly string[] {
  const pythonBin = process.platform === "win32" ? "Scripts" : "bin";
  return ["node_modules/.bin", `.venv/${pythonBin}`, `venv/${pythonBin}`, "vendor/bin"].map(
    (directory) => path.resolve(cwd, directory),
  );
}

/** Normalize case-insensitive Windows environment keys before merging launch overrides. */
export function normalizeProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return { ...environment };
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key.toUpperCase(), value]),
  );
}

/** Prepend native project tools while preserving the platform's PATH key rules. */
export function projectProcessEnvironment(
  cwd: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const effective = normalizeProcessEnvironment(environment);
  effective.PATH = [...projectExecutableDirectories(cwd), effective.PATH]
    .filter(Boolean)
    .join(path.delimiter);
  return effective;
}

/** Check availability without starting a process; cancellation is checked between native filesystem calls. */
export async function isExecutableAvailable(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const effective = projectProcessEnvironment(cwd, environment);
  const locations =
    path.isAbsolute(command) || path.dirname(command) !== "."
      ? [path.resolve(cwd, command)]
      : (effective.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((directory) =>
            path.join(
              process.platform === "win32" ? directory.replace(/^"|"$/gu, "") : directory,
              command,
            ),
          );
  const suffixes =
    process.platform === "win32"
      ? [
          ...new Set(
            (effective.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
              .split(";")
              .filter(Boolean)
              .flatMap((suffix) => [suffix, suffix.toLowerCase()]),
          ),
        ]
      : [];
  const candidates = locations.flatMap((location) => [
    location,
    ...suffixes.map((suffix) => `${location}${suffix}`),
  ]);
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    try {
      await access(candidate, constants.X_OK);
      signal?.throwIfAborted();
      const information = await stat(candidate);
      signal?.throwIfAborted();
      if (!information.isFile()) continue;
      return true;
    } catch {
      signal?.throwIfAborted();
      // Try the next executable location.
    }
  }
  return false;
}

/** Result of checking whether one external command can start successfully. */
export type ExecutableProbeResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly detail: string };

/** Capture a version or error description; await the owned leader's close on timeout or cancellation. */
export function probeExecutable(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<ExecutableProbeResult> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: projectProcessEnvironment(cwd, environment),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stopping = false;
    let spawnError: string | undefined;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      child.kill();
      forceStop = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceStop.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, 5_000);
    signal?.addEventListener("abort", stop, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      spawnError = error.message;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(forceStop);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (timedOut) {
        resolve({ ok: false, detail: `${command} did not respond within 5 seconds` });
        return;
      }
      const output = (stdout.trim() || stderr.trim()).split(/\r?\n/u)[0];
      resolve({
        ok: spawnError === undefined && code === 0,
        detail: spawnError ?? (output || `${command} exited with code ${String(code)}`),
      });
    });
    if (signal?.aborted) stop();
    timeout.unref();
  });
}
