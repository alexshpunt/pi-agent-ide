import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
  BrowserLoadOptions,
  BrowserPageSnapshot,
} from "#src/extensions/pi-agent-read/extensions/pi-agent-web/src/browser-loader.js";
import { readOwnedSshCommand } from "./owned-read-command.js";
import { SshBackendError, type SshTarget } from "./ssh.js";

const pageSchema = Type.Object({ html: Type.String(), source: Type.String() });
const refusalCodes = new Set([
  "CAPABILITY_UNAVAILABLE",
  "INVALID_SOURCE",
  "BYTE_LIMIT",
  "TIMEOUT",
  "HTTP_FAILED",
  "BROWSER_FAILED",
  "CANCELLED",
]);
let worker: Promise<string> | undefined;

/** Render a page using target-installed Playwright and Chromium, never a controller browser. */
export async function readSshBrowserPage(
  target: SshTarget,
  url: URL,
  source: string,
  options: BrowserLoadOptions,
): Promise<BrowserPageSnapshot> {
  const page = await runBrowser(target, url, source, options, "html");
  if (!Value.Check(pageSchema, page) || Buffer.byteLength(page.html, "utf8") > 16 * 1024 * 1024)
    throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
  const finalUrl = new URL(page.source);
  if (!["http:", "https:"].includes(finalUrl.protocol) || finalUrl.username || finalUrl.password)
    throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
  return page;
}

/** Capture target web pixels for the existing image transforms; unavailable targets never capture locally. */
export async function captureSshBrowserImage(
  target: SshTarget,
  url: URL,
  source: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const frame = await runBrowser(target, url, source, { signal, timeoutMs: 30_000 }, "image");
  if (
    typeof frame !== "object" ||
    frame === null ||
    !("png" in frame) ||
    typeof frame.png !== "string"
  )
    throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
  const bytes = Buffer.from(frame.png, "base64");
  if (
    bytes.toString("base64") !== frame.png ||
    bytes.length > 20 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
  return bytes;
}

/** Probe the target browser using the same installed runtime and private launch path, without navigation. */
export async function probeSshBrowser(
  target: SshTarget,
  source: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runBrowser(
    target,
    new URL("about:blank"),
    source,
    { signal, timeoutMs: 5_000 },
    "probe",
  );
  if (!Value.Check(Type.Object({ ready: Type.Literal(true) }), result))
    throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
}

async function runBrowser(
  target: SshTarget,
  url: URL,
  source: string,
  options: BrowserLoadOptions,
  kind: "html" | "image" | "probe",
): Promise<unknown> {
  options.signal?.throwIfAborted();
  worker ??= readFile(new URL("./web-browser-worker.mjs", import.meta.url), "utf8");
  try {
    const result = await readOwnedSshCommand(
      target,
      "node",
      [
        "--input-type=module",
        "-e",
        await worker,
        JSON.stringify({ kind, url: url.href, timeoutMs: options.timeoutMs }),
      ],
      source,
      { signal: options.signal, timeoutMs: options.timeoutMs, maxBytes: 32 * 1024 * 1024 },
    );
    if (result.exitCode !== 0) throw new SshBackendError("BROWSER_FAILED", source, "not-applied");
    let reply: unknown;
    try {
      reply = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
    }
    if (typeof reply === "object" && reply !== null && "error" in reply)
      throw new SshBackendError(
        typeof reply.error === "string" && refusalCodes.has(reply.error)
          ? reply.error
          : "INVALID_RESPONSE",
        source,
        "not-applied",
      );
    return reply;
  } catch (error) {
    if (error instanceof SshBackendError)
      throw new SshBackendError(
        error.code === "ENOENT" ? "CAPABILITY_UNAVAILABLE" : error.code,
        source,
        error.effect,
      );
    throw error;
  }
}
