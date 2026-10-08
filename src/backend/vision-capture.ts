import { readFile } from "node:fs/promises";
import type { SshBackendRegistry } from "./registry.js";
import type { SshTarget } from "./ssh.js";
import { SshBackendError } from "./ssh.js";
import { readOwnedSshCommand } from "./owned-read-command.js";

/** A native target frame request. Window identity must come from an authorized target snapshot. */
export type SshCaptureRequest =
  | {
      readonly kind: "window";
      readonly pid: number;
      readonly identity: string;
      readonly executable: string;
    }
  | { readonly kind: "display"; readonly index: number };

/** Connect to target X11 and check trusted client support without pixels or opt-in changes.
 * This is readiness only, not authorization for any particular window or display.
 */
export async function probeSshCapture(
  target: SshTarget,
  source: string,
  signal?: AbortSignal,
): Promise<{
  display: { ok: boolean; detail: string };
  window: { ok: boolean; detail: string };
}> {
  signal?.throwIfAborted();
  worker ??= readFile(new URL("./vision-capture-worker.py", import.meta.url), "utf8");
  const result = await readOwnedSshCommand(
    target,
    "python3",
    ["-c", await worker, JSON.stringify({ kind: "probe" })],
    source,
    { signal, timeoutMs: 5_000, maxBytes: 128 * 1024 },
  );
  signal?.throwIfAborted();
  if (result.exitCode !== 0)
    throw new SshBackendError("CAPABILITY_UNAVAILABLE", source, "not-applied");
  let reply: unknown;
  try {
    reply = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
  }
  if (typeof reply !== "object" || reply === null)
    throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
  if (
    "display" in reply &&
    reply.display === true &&
    "window" in reply &&
    typeof reply.window === "boolean" &&
    (reply.window || ("error" in reply && reply.error === "CAPABILITY_UNAVAILABLE"))
  ) {
    return {
      display: {
        ok: true,
        detail: "Target X11 connection opened without pixels; capture opt-in unchanged",
      },
      window: {
        ok: reply.window,
        detail: reply.window
          ? "Target X-Resource 1.2 is available; individual window authorization is not checked"
          : `CAPABILITY_UNAVAILABLE: ${source} (trusted X11 client identity unavailable)`,
      },
    };
  }
  const code =
    "error" in reply && typeof reply.error === "string" && refusalCodes.has(reply.error)
      ? reply.error
      : "INVALID_RESPONSE";
  throw new SshBackendError(code, source, "not-applied");
}
let worker: Promise<string> | undefined;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const refusalCodes = new Set([
  "DESKTOP_UNAVAILABLE",
  "CAPABILITY_UNAVAILABLE",
  "ENOENT",
  "EACCES",
  "STALE_PROCESS",
  "AMBIGUOUS_WINDOW",
  "WINDOW_OBSCURED",
  "CONTENT_LIMIT",
  "PIXEL_LIMIT",
  "BYTE_LIMIT",
]);

/** Acquire bounded X11 pixels on the configured target, never from the controller desktop.
 * The caller checks capture opt-in and authorizes the exact target executable before each frame.
 * The worker rechecks boot/start identity and executable around the requested drawable read.
 */
export async function captureSshFrame(
  registry: SshBackendRegistry,
  source: string,
  request: SshCaptureRequest,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const prefix = request.kind === "window" ? "window:" : "display:";
  if (!source.startsWith(`${prefix}ssh://`))
    throw new SshBackendError("INVALID_SOURCE", source, "not-applied");
  const uri = new URL(source.slice(prefix.length));
  const selected = request.kind === "window" ? request.pid : request.index;
  if (
    uri.username ||
    uri.password ||
    uri.port ||
    uri.search ||
    !Number.isSafeInteger(selected) ||
    (request.kind === "window"
      ? selected < 1 || uri.pathname !== `/${selected}` || uri.hash !== ""
      : selected < 0 ||
        uri.pathname !== "/" ||
        (uri.hash !== `#${selected}` && !(selected === 0 && uri.hash === "")))
  )
    throw new SshBackendError("INVALID_SOURCE", source, "not-applied");
  try {
    const owner = registry.resolve(`ssh://${uri.hostname}/`);
    if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
    worker ??= readFile(new URL("./vision-capture-worker.py", import.meta.url), "utf8");
    const result = await readOwnedSshCommand(
      owner.backend.target,
      "python3",
      ["-c", await worker, JSON.stringify(request)],
      source,
      { signal, timeoutMs: 10_000, maxBytes: 20 * 1024 * 1024 },
    );
    signal?.throwIfAborted();
    if (result.exitCode !== 0)
      throw new SshBackendError("CAPABILITY_UNAVAILABLE", source, "not-applied");
    if (result.stdout.subarray(0, 8).equals(PNG_SIGNATURE)) {
      if (
        result.stdout.length < 33 ||
        result.stdout.length > 20 * 1024 * 1024 ||
        result.stdout.toString("ascii", 12, 16) !== "IHDR"
      )
        throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
      const width = result.stdout.readUInt32BE(16),
        height = result.stdout.readUInt32BE(20);
      if (width < 1 || height < 1 || width * height > 16 * 1024 * 1024)
        throw new SshBackendError("PIXEL_LIMIT", source, "not-applied");
      return result.stdout;
    }
    let reply: unknown;
    try {
      reply = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
    }
    const code =
      typeof reply === "object" &&
      reply !== null &&
      "error" in reply &&
      typeof reply.error === "string" &&
      refusalCodes.has(reply.error)
        ? reply.error
        : "INVALID_RESPONSE";
    throw new SshBackendError(code, source, "not-applied");
  } catch (error) {
    if (error instanceof SshBackendError)
      throw new SshBackendError(error.code, source, error.effect);
    throw error;
  }
}
