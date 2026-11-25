import { execFile } from "node:child_process";
import { currentLinearAuthEpoch, currentLinearConnectionId } from "./auth-boundary.ts";
import { linearResourceError, withLinearRateLimit } from "./resource-failure.ts";
// A versioned npm alias keeps this codec separate from other extensions' TOON versions.
import { decode } from "@toon-format/toon-v4";

import { runAxiWorker, type AxiWorkerOutput } from "./axi-worker.ts";
import { axiPath } from "./config.ts";
import { isDocumentId, parseDocumentUrl, parseIssueUrl } from "./urls.ts";

/** Issue fields returned by the full AXI issue view. */
export interface LinearIssue {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly uuid?: string;
  readonly project?: string;
  readonly team?: string;
  readonly status?: string;
  readonly attachments?: readonly LinearAttachment[];
  readonly documents?: readonly LinearDocumentLink[];
}

/** External attachment metadata; bodies are read by the provider owning the URL. */
export interface LinearAttachment {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

/** An issue-linked document has a UUID and title even when AXI omits its native URL. */
export interface LinearDocumentLink {
  readonly id: string;
  readonly title: string;
}

/** Full document returned through the existing authenticated AXI backend. */
export interface LinearDocument {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly content: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strictly decode selected AXI object fields, excluding unrelated CLI metadata. */
export function decodeAxiObject(
  output: string,
  root: string,
  fields: readonly string[],
): Record<string, unknown> {
  // AXI's unused nested history has non-standard indentation. Project the needed
  // object fields, then strictly decode them, including attachment/document counts.
  const lines: string[] = [];
  let inside = false;
  let include = false;
  for (const line of output.split("\n")) {
    if (/^\S/u.test(line)) {
      inside = line === `${root}:`;
      include = false;
      if (inside) lines.push(line);
    } else if (inside) {
      const key = /^ {2}([A-Za-z]\w*)(?=[:[])/u.exec(line)?.[1];
      if (key) include = fields.includes(key);
      if (include) lines.push(line);
    }
  }
  try {
    const data = decode(lines.join("\n"));
    if (record(data)) return data;
  } catch {
    /* Expose a safe code, never raw CLI output. */
  }
  throw new Error("LINEAR_INVALID_RESPONSE");
}

function linkedRows(value: unknown, attachments: true): LinearAttachment[];
function linkedRows(value: unknown, attachments: false): LinearDocumentLink[];
function linkedRows(
  value: unknown,
  attachments: boolean,
): (LinearAttachment | LinearDocumentLink)[] {
  if (!Array.isArray(value)) throw new Error("LINEAR_INVALID_RESPONSE");
  return value.map((item) => {
    if (!record(item) || typeof item.id !== "string" || typeof item.title !== "string") {
      throw new Error("LINEAR_INVALID_RESPONSE");
    }
    if (!attachments) {
      if (!isDocumentId(item.id)) throw new Error("LINEAR_INVALID_RESPONSE");
      return { id: item.id, title: item.title };
    }
    if (typeof item.url !== "string") throw new Error("LINEAR_INVALID_RESPONSE");
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      throw new Error("LINEAR_INVALID_RESPONSE");
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("LINEAR_INVALID_RESPONSE");
    }
    return { id: item.id, title: item.title, url: url.href };
  });
}
/** Decode the CLI's documented TOON output and verify the requested workspace and issue. */
export function decodeIssue(output: string, source: string): LinearIssue {
  const issue = decodeAxiObject(output, "issue", [
    "id",
    "identifier",
    "title",
    "url",
    "description",
    "uuid",
    "project",
    "team",
    "status",
    "attachments",
    "documents",
  ]).issue;
  if (
    !record(issue) ||
    typeof issue.id !== "string" ||
    (issue.identifier !== undefined && typeof issue.identifier !== "string") ||
    typeof issue.title !== "string" ||
    typeof issue.url !== "string" ||
    (issue.description !== null &&
      issue.description !== undefined &&
      typeof issue.description !== "string")
  ) {
    throw new Error("LINEAR_INVALID_RESPONSE");
  }
  const identifier = typeof issue.identifier === "string" ? issue.identifier : issue.id;
  const uuid = isDocumentId(issue.id) ? issue.id : issue.uuid;
  const requested = parseIssueUrl(source);
  const returned = parseIssueUrl(issue.url);
  if (
    !requested ||
    !returned ||
    requested.workspace !== returned.workspace ||
    requested.identifier !== returned.identifier ||
    identifier !== requested.identifier ||
    (issue.id !== identifier && !isDocumentId(issue.id)) ||
    (isDocumentId(issue.id) && issue.uuid !== undefined && issue.uuid !== issue.id)
  ) {
    throw new Error("LINEAR_IDENTITY_MISMATCH");
  }
  return {
    id: identifier,
    ...(typeof uuid === "string" ? { uuid } : {}),
    title: issue.title,
    url: returned.source,
    description: typeof issue.description === "string" ? issue.description : "",
    ...(issue.attachments === undefined
      ? {}
      : {
          attachments: linkedRows(issue.attachments, true),
        }),
    ...(issue.documents === undefined
      ? {}
      : {
          documents: linkedRows(issue.documents, false),
        }),
    ...Object.fromEntries(
      ["project", "team", "status"]
        .filter((key) => typeof issue[key] === "string")
        .map((key) => [key, issue[key]]),
    ),
  };
}

/** Verify workspace plus UUID or native slug before exposing a document's content. */
export function decodeDocument(output: string, source: string): LinearDocument {
  const document = decodeAxiObject(output, "document", ["id", "title", "url", "content"]).document;
  if (
    !record(document) ||
    typeof document.id !== "string" ||
    !isDocumentId(document.id) ||
    typeof document.title !== "string" ||
    typeof document.url !== "string" ||
    (document.content !== null &&
      document.content !== undefined &&
      typeof document.content !== "string")
  ) {
    throw new Error("LINEAR_INVALID_RESPONSE");
  }
  const requested = parseDocumentUrl(source);
  const returned = parseDocumentUrl(document.url);
  if (
    !requested ||
    !returned ||
    !returned.native ||
    requested.workspace !== returned.workspace ||
    (isDocumentId(requested.identifier)
      ? requested.identifier !== document.id.toLowerCase()
      : requested.identifier !== returned.identifier)
  ) {
    throw new Error("LINEAR_IDENTITY_MISMATCH");
  }
  return {
    id: document.id,
    title: document.title,
    url: returned.source,
    content: typeof document.content === "string" ? document.content : "",
  };
}
function cliFailure(output: string, systemCode?: string): Error {
  if (systemCode === "ENOENT") return new Error("LINEAR_AXI_NOT_FOUND");
  let data: unknown;
  try {
    data = decode(
      output
        .split("\n")
        .filter((line) => /^(?:error|code|rateLimit|effect):/u.test(line))
        .join("\n"),
    );
  } catch {
    /* Never expose raw process output. */
  }
  if (record(data)) {
    if (
      typeof data.error === "string" &&
      /OAuth authorization required|unauthorized|authentication required/iu.test(data.error)
    ) {
      return new Error("LINEAR_AUTH_REQUIRED");
    }
    if (typeof data.error === "string" && /^LINEAR_[A-Z_]+$/u.test(data.error)) {
      if (data.effect === "not-applied" || data.effect === "applied" || data.effect === "unknown")
        return linearResourceError(data.error, "linear://", data.effect, data.rateLimit);
      return withLinearRateLimit(new Error(data.error), data.rateLimit);
    }
    if (data.code === "NOT_FOUND") return new Error("LINEAR_NOT_FOUND");
  }
  return new Error("LINEAR_AXI_FAILED");
}

/** Run fixed AXI arguments without a shell, with bounded output and operation cancellation. */
export async function runAxi(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  onAuthorization?: (url: string) => void,
  timeoutMs = onAuthorization ? 125_000 : 30_000,
): Promise<string> {
  signal?.throwIfAborted();
  const executable = await axiPath(cwd);
  const javascript = /\.[cm]?js$/u.test(executable);
  const epoch = currentLinearAuthEpoch();
  const connectionId = currentLinearConnectionId();
  const environment = { ...process.env };
  delete environment.LINEAR_AXI_AUTH_EPOCH;
  delete environment.LINEAR_AXI_CONNECTION_ID;
  if (epoch !== undefined) environment.LINEAR_AXI_AUTH_EPOCH = epoch;
  if (connectionId !== undefined) environment.LINEAR_AXI_CONNECTION_ID = connectionId;
  // Authorization streams its URL from a process of its own; a leading flag or no arguments
  // (help, version) is never a worker command, so starting the worker for it only adds a
  // second cold start. Everything else may share the backend's worker, which answers in
  // milliseconds instead of starting a CLI each time.
  if (!onAuthorization && args.length > 0 && !args[0].startsWith("-")) {
    let output: AxiWorkerOutput | undefined;
    try {
      output = await runAxiWorker(executable, cwd, args, environment, {
        signal,
        timeoutMs,
        maxBytes: 2 * 1024 * 1024,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error instanceof Error && error.message === "LINEAR_AXI_TIMEOUT"
        ? error
        : new Error("LINEAR_AXI_FAILED");
    }
    if (output) {
      if (output.exitCode !== 0) throw cliFailure(output.stdout);
      return output.stdout;
    }
  }
  return new Promise((resolve, reject) => {
    let stopped = false;
    const child = execFile(
      javascript ? process.execPath : executable,
      [...(javascript ? [executable] : []), ...args],
      {
        cwd,
        signal,
        encoding: "utf8",
        env: environment,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        if (error) {
          // execFile stops the process at its timeout; no output explains that.
          reject(
            error.killed && !stopped && error.code === null
              ? new Error("LINEAR_AXI_TIMEOUT")
              : cliFailure(`${stdout}\n${stderr}`, String(error.code)),
          );
          return;
        }
        resolve(stdout);
      },
    );
    if (!onAuthorization) return;
    let pending = "";
    let announced = false;
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (announced || !line.startsWith("url: ")) continue;
        try {
          const data = decode(line);
          if (!record(data) || typeof data.url !== "string") continue;
          const url = new URL(data.url);
          if (
            url.protocol !== "https:" ||
            (url.hostname !== "linear.app" && !url.hostname.endsWith(".linear.app"))
          )
            continue;
          announced = true;
          onAuthorization(url.href);
        } catch {
          stopped = true;
          child.kill();
        }
      }
    });
  });
}

/** Read one full issue through the authenticated CLI; do not create or mutate anything. */
export async function readAxiIssue(
  source: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  const reference = parseIssueUrl(source);
  if (!reference) throw new Error("LINEAR_INVALID_URL");
  return decodeIssue(
    await runAxi(cwd, ["issues", "view", reference.identifier, "--full"], signal),
    source,
  );
}

/** Read one full document by UUID or native URL through AXI, without mutations. */
export async function readAxiDocument(
  source: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<LinearDocument> {
  const reference = parseDocumentUrl(source);
  if (!reference) throw new Error("LINEAR_INVALID_URL");
  return decodeDocument(
    await runAxi(
      cwd,
      ["documents", "view", reference.native ? reference.source : reference.identifier, "--full"],
      signal,
    ),
    source,
  );
}
