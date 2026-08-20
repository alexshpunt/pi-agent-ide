import { spawn } from "node:child_process";

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
      env: environment,
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

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => finish(false, error.message));
    child.once("close", (code) => {
      const output = (stdout.trim() || stderr.trim()).split(/\r?\n/u)[0];
      finish(code === 0, output || `${command} exited with code ${String(code)}`);
    });
    timeout.unref();
  });
}
