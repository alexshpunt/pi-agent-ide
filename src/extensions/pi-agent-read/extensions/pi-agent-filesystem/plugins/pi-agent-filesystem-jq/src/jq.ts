import spawn from "cross-spawn";
import { projectProcessEnvironment } from "pi-agent-doctor/api/executable";

import { fileURLToPath } from "node:url";

const JQ_TIMEOUT_MS = 5_000;
const JQ_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const JQ_MODULE_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));

export interface JqView {
  readonly filter: string;
}

/** Parse one exclusive parameterized jq view from a Read request. */
export function parseJqView(views: readonly string[] | undefined): JqView | undefined {
  const jqViews = views?.filter((view) => view === "jq" || view.startsWith("jq:")) ?? [];
  if (jqViews.length === 0) return undefined;
  if (jqViews.length > 1) throw new Error("Read accepts only one jq view");
  if (views?.length !== 1) throw new Error("The jq view cannot be combined with other views");
  const selected = jqViews[0];
  if (selected === undefined || selected === "jq" || selected.slice(3).trim().length === 0)
    throw new Error('The jq view requires a filter, for example views: ["jq:.scripts"]');
  return { filter: selected.slice(3) };
}

/** Run the real jq executable over one JSON text with bounded output and no shell. */
export function executeJq(
  filter: string,
  input: string,
  options: { readonly cwd: string; readonly signal?: AbortSignal; readonly command?: string },
): Promise<string> {
  if (options.signal?.aborted === true)
    return Promise.reject(new Error("jq execution was cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(options.command ?? "jq", ["-L", JQ_MODULE_DIRECTORY, "--", filter], {
      cwd: options.cwd,
      env: safeEnvironment(options.cwd),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let outputBytes = 0;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (error === undefined) resolve(stdout);
      else reject(error);
    };
    const stop = (error: Error): void => {
      child.kill();
      finish(error);
    };
    const abort = (): void => stop(new Error("jq execution was cancelled"));
    const timeout = setTimeout(
      () => stop(new Error(`jq did not finish within ${JQ_TIMEOUT_MS / 1_000} seconds`)),
      JQ_TIMEOUT_MS,
    );
    timeout.unref();
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > JQ_MAX_OUTPUT_BYTES) {
        stop(new Error(`jq output exceeded ${JQ_MAX_OUTPUT_BYTES / 1024 / 1024}MB`));
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr) < 16_384) stderr += chunk;
    });
    child.once("error", (error) => finish(new Error(`Cannot start jq: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code === 0) finish();
      else {
        const detail = stderr.trim().split(/\r?\n/u).slice(0, 8).join("\n");
        finish(
          new Error(
            detail ||
              `jq exited ${signal === null ? `with code ${String(code)}` : `after signal ${signal}`}`,
          ),
        );
      }
    });
    child.stdin?.once("error", (error) =>
      finish(new Error(`Cannot send JSON to jq: ${error.message}`)),
    );
    child.stdin?.end(input);
  });
}

function safeEnvironment(cwd: string): NodeJS.ProcessEnv {
  const source = projectProcessEnvironment(cwd, process.env);
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR"]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}
