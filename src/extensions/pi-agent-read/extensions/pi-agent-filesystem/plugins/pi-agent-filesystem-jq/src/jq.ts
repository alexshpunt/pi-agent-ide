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
  if (views?.length !== 1)
    throw new Error(
      "The jq view cannot be combined with other views. Keep only one jq:<filter> in views.",
    );
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
  if (hasModuleOperation(filter)) return Promise.reject(new Error("jq module loading is disabled"));
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

/** Find module syntax outside strings/comments, including expressions inside string interpolation. */
function hasModuleOperation(filter: string): boolean {
  const contexts: ("string" | number)[] = [0];
  let index = 0;
  let previous = "";
  while (index < filter.length) {
    const character = filter[index];
    const context = contexts.at(-1);
    if (context === "string") {
      if (character === "\\") {
        if (filter[index + 1] === "(") {
          contexts.push(0);
          previous = "";
        }
        index += 2;
      } else {
        if (character === '"') {
          contexts.pop();
          previous = '"';
        }
        index += 1;
      }
      continue;
    }
    if (character === "#") {
      const newline = filter.indexOf("\n", index);
      index = newline < 0 ? filter.length : newline + 1;
      continue;
    }
    if (character === '"') contexts.push("string");
    else if (character === "(") contexts[contexts.length - 1] = (context ?? 0) + 1;
    else if (character === ")") {
      if (contexts.length > 1 && context === 0) contexts.pop();
      else contexts[contexts.length - 1] = Math.max(0, (context ?? 0) - 1);
    } else if (/[A-Za-z_]/u.test(character ?? "")) {
      const start = index;
      while (/[A-Za-z0-9_]/u.test(filter[index] ?? "")) index += 1;
      const token = filter.slice(start, index);
      const next = nextCode(filter, index);
      const fieldOrVariable = previous === "." || previous === "$";
      const objectKey = next.startsWith(":") && !next.startsWith("::");
      if (
        !fieldOrVariable &&
        !objectKey &&
        (token === "include" || token === "import" || token === "modulemeta")
      )
        return true;
      previous = token;
      continue;
    }
    if (character !== undefined && !/\s/u.test(character)) previous = character;
    index += 1;
  }
  return false;
}
function nextCode(filter: string, start: number): string {
  let index = start;
  while (index < filter.length) {
    if (/\s/u.test(filter[index] ?? "")) index += 1;
    else if (filter[index] === "#") {
      const newline = filter.indexOf("\n", index);
      index = newline < 0 ? filter.length : newline + 1;
    } else break;
  }
  return filter.slice(index, index + 2);
}
function safeEnvironment(cwd: string): NodeJS.ProcessEnv {
  const source = projectProcessEnvironment(cwd, process.env);
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR"]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}
