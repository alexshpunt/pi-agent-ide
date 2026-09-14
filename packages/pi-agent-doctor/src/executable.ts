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

/** Returns whether an executable is available without starting it. */
export async function isExecutableAvailable(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
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
    try {
      await access(candidate, constants.X_OK);

      if (!(await stat(candidate)).isFile()) continue;
      return true;
    } catch {
      // Try the next executable location.
    }
  }
  return false;
}

/** Result of checking whether one external command can start successfully. */
export type ExecutableProbeResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly detail: string };

/** Start an external command and capture a short version or error description. */
export function probeExecutable(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<ExecutableProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: projectProcessEnvironment(cwd, environment),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(false, `${command} did not respond within 5 seconds`);
    }, 5_000);
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(ok ? { ok: true, detail } : { ok: false, detail });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => finish(false, error.message));
    child.once("close", (code) => {
      const output = (stdout.trim() || stderr.trim()).split(/\r?\n/u)[0];
      finish(code === 0, output || `${command} exited with code ${String(code)}`);
    });
    timeout.unref();
  });
}
