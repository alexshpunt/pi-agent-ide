import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { SshBackendError, type SshTarget } from "./ssh.js";
import { readOwnedSshCommand } from "./owned-read-command.js";

const responseSchema = Type.Object({
  url: Type.String(),
  status: Type.Integer({ minimum: 200, maximum: 599 }),
  statusText: Type.String(),
  headers: Type.Array(Type.Tuple([Type.String(), Type.String()])),
  body: Type.String(),
});
const refusalCodes = new Set(["INVALID_SOURCE", "BYTE_LIMIT", "TIMEOUT", "HTTP_FAILED"]);
let worker: Promise<string> | undefined;

/** GET one URL on its configured target; callers reuse the ordinary local conversion pipeline. */
export async function fetchSshWebResponse(
  target: SshTarget,
  url: URL,
  source: string,
  signal?: AbortSignal,
): Promise<Response> {
  signal?.throwIfAborted();
  worker ??= readFile(new URL("./web-http-worker.py", import.meta.url), "utf8");
  try {
    const result = await readOwnedSshCommand(
      target,
      "python3",
      ["-c", await worker, JSON.stringify({ url: url.href, timeoutSeconds: 30 })],
      source,
      { signal, timeoutMs: 30_000, maxBytes: 32 * 1024 * 1024 },
    );
    if (result.exitCode !== 0) throw new SshBackendError("HTTP_FAILED", source, "not-applied");
    let reply: unknown;
    try {
      reply = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
    }
    if (typeof reply === "object" && reply !== null && "error" in reply) {
      throw new SshBackendError(
        typeof reply.error === "string" && refusalCodes.has(reply.error)
          ? reply.error
          : "INVALID_RESPONSE",
        source,
        "not-applied",
      );
    }
    if (!Value.Check(responseSchema, reply))
      throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
    const bytes = Buffer.from(reply.body, "base64");
    if (bytes.toString("base64") !== reply.body || bytes.length > 16 * 1024 * 1024)
      throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
    let response: Response;
    try {
      const finalUrl = new URL(reply.url);
      if (
        !["http:", "https:"].includes(finalUrl.protocol) ||
        finalUrl.username ||
        finalUrl.password
      )
        throw new Error("Invalid native HTTP redirect");
      response = new Response([204, 205, 304].includes(reply.status) ? null : bytes, {
        status: reply.status,
        statusText: reply.statusText,
        headers: reply.headers,
      });
      Object.defineProperty(response, "url", { value: finalUrl.href });
    } catch {
      throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
    }
    return response;
  } catch (error) {
    if (error instanceof SshBackendError)
      throw new SshBackendError(error.code, source, error.effect);
    throw error;
  }
}
