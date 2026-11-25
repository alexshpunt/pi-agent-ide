import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { ResourceError, type AgentContent, type ResourceResolver } from "pi-agent-ide/api/resource";
import { GithubApiError, type GithubClient, type GithubCredentials } from "./client.ts";
import { githubResourceError } from "./resource-error.ts";
import { isGithubRateLimitResponse, rateLimitInfoFromHeaders } from "./rate-limit.ts";
import type { GithubRequestCoordinator } from "./request-coordinator.ts";
import { githubSource, parseGithubAddress, type GithubAddress } from "./address.ts";
import type { GithubApproval, GithubReceipt, GithubRestReader } from "./backend.ts";

/** Session-owned connection credentials for native binary transport, never shell credentials. */
export type GithubCredentialsProvider = (cwd: string) => Promise<GithubCredentials>;

const maximumBytes = 25 * 1024 * 1024;
const apiOrigin = "https://api.github.com";
const uploadOrigin = "https://uploads.github.com";
const cdnOrigins = new Set([
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
type Effect = "not-applied" | "unknown";
interface AssetMetadata {
  id: number;
  name: string;
  size: number;
  contentType: string;
  url?: string;
}
interface UploadInput {
  file: string;
  name: string;
  label?: string;
  contentType?: string;
}

function fail(code: string, source: string, effect: Effect = "not-applied"): never {
  throw new ResourceError(code, source, effect);
}
function cancellationCode(signal: AbortSignal): string {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? "GH_TIMEOUT"
    : "GH_CANCELLED";
}
function check(signal: AbortSignal, source: string, effect: Effect = "not-applied"): void {
  if (signal.aborted) fail(cancellationCode(signal), source, effect);
}
function boundedSignal(caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(20_000);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}
async function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
  source: string,
  effect: Effect = "not-applied",
): Promise<T> {
  check(signal, source, effect);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ResourceError(cancellationCode(signal), source, effect));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function record(
  value: unknown,
  source: string,
  effect: Effect = "not-applied",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("GH_INVALID_ASSET_RESPONSE", source, effect);
  return value as Record<string, unknown>;
}
function assetId(address: GithubAddress): number | undefined {
  return address.parts.length === 3 &&
    address.parts[0] === "releases" &&
    address.parts[1] === "assets" &&
    /^\d+$/.test(address.parts.at(2) ?? "") &&
    Number.isSafeInteger(Number(address.parts[2])) &&
    Number(address.parts[2]) > 0
    ? Number(address.parts[2])
    : undefined;
}
function releaseId(address: GithubAddress): number | undefined {
  return address.parts.length === 4 &&
    address.parts[0] === "releases" &&
    /^\d+$/.test(address.parts.at(1) ?? "") &&
    address.parts[2] === "assets" &&
    address.parts[3] === "new" &&
    Number.isSafeInteger(Number(address.parts[1])) &&
    Number(address.parts[1]) > 0
    ? Number(address.parts[1])
    : undefined;
}
function assetRoute(address: GithubAddress, id: number): string {
  return `/repos/${address.owner}/${address.repo}/releases/assets/${id}`;
}
function trustedUrl(
  raw: unknown,
  source: string,
  code: string,
  effect: Effect = "not-applied",
): URL {
  if (typeof raw !== "string" || raw.includes("\\")) fail(code, source, effect);
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      fail(code, source, effect);
    return url;
  } catch {
    fail(code, source, effect);
  }
}
function metadata(
  value: unknown,
  address: GithubAddress,
  id: number,
  effect: Effect = "not-applied",
): AssetMetadata {
  const data = record(value, address.source, effect);
  if (data.id !== id) fail("GH_ASSET_IDENTITY_MISMATCH", address.source, effect);
  if (
    typeof data.name !== "string" ||
    !data.name ||
    data.name.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(data.name) ||
    !Number.isSafeInteger(data.size) ||
    Number(data.size) < 0
  )
    fail("GH_INVALID_ASSET_RESPONSE", address.source, effect);
  if (Number(data.size) > maximumBytes) fail("GH_ASSET_TOO_LARGE", address.source, effect);
  if (data.url !== undefined) {
    const url = trustedUrl(data.url, address.source, "GH_ASSET_IDENTITY_MISMATCH", effect);
    if (
      url.origin !== apiOrigin ||
      url.search ||
      url.pathname.toLowerCase() !== assetRoute(address, id).toLowerCase()
    )
      fail("GH_ASSET_IDENTITY_MISMATCH", address.source, effect);
  }
  let browserUrl: string | undefined;
  if (data.browser_download_url !== undefined) {
    const url = trustedUrl(
      data.browser_download_url,
      address.source,
      "GH_ASSET_IDENTITY_MISMATCH",
      effect,
    );
    if (
      url.origin !== "https://github.com" ||
      url.search ||
      !url.pathname
        .toLowerCase()
        .startsWith(`/${address.owner}/${address.repo}/releases/download/`.toLowerCase())
    )
      fail("GH_ASSET_IDENTITY_MISMATCH", address.source, effect);
    browserUrl = url.href;
  }
  const contentType =
    typeof data.content_type === "string" &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(data.content_type)
      ? data.content_type
      : "application/octet-stream";
  return {
    id,
    name: data.name,
    size: Number(data.size),
    contentType,
    ...(browserUrl ? { url: browserUrl } : {}),
  };
}
function uploadInput(content: string, source: string): UploadInput {
  let input: Record<string, unknown>;
  try {
    input = record(JSON.parse(content), source);
  } catch {
    fail("GH_INVALID_UPLOAD_INPUT", source);
  }
  if (
    Object.keys(input).some((key) => !["file", "name", "label", "contentType"].includes(key)) ||
    typeof input.file !== "string" ||
    !input.file ||
    input.file.includes("\u0000") ||
    typeof input.name !== "string" ||
    !input.name ||
    input.name.length > 255 ||
    /[\u0000-\u001f\u007f/\\]/u.test(input.name) ||
    /^\.{1,2}$/.test(input.name) ||
    (input.label !== undefined &&
      (typeof input.label !== "string" ||
        input.label.length > 255 ||
        /[\u0000-\u001f\u007f]/u.test(input.label))) ||
    (input.contentType !== undefined &&
      (typeof input.contentType !== "string" ||
        !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(input.contentType)))
  )
    fail("GH_INVALID_UPLOAD_INPUT", source);
  return {
    file: input.file,
    name: input.name,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
  };
}
async function localBytes(filePath: string, source: string, signal: AbortSignal): Promise<Buffer> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    check(signal, source);
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile()) fail("GH_ASSET_FILE_INVALID", source);
    if (before.size > maximumBytes) fail("GH_ASSET_TOO_LARGE", source);
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      check(signal, source);
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1 - length));
      const result = await file.read(chunk, 0, chunk.length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
      if (length > maximumBytes) fail("GH_ASSET_TOO_LARGE", source);
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    const after = await file.stat();
    if (before.size !== length || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      fail("GH_ASSET_FILE_CHANGED", source);
    check(signal, source);
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (error instanceof ResourceError) throw error;
    check(signal, source);
    return fail("GH_ASSET_FILE_INVALID", source);
  } finally {
    await file?.close();
  }
}
async function responseBytes(
  response: Response,
  cap: number,
  signal: AbortSignal,
  source: string,
  effect: Effect,
): Promise<Buffer> {
  const advertised = response.headers.get("content-length");
  if (advertised && /^\d+$/.test(advertised) && Number(advertised) > cap) {
    void response.body?.cancel().catch(() => undefined);
    fail("GH_ASSET_TOO_LARGE", source, effect);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal, source, effect);
      check(signal, source, effect);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > cap) fail("GH_ASSET_TOO_LARGE", source, effect);
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ResourceError) throw error;
    check(signal, source, effect);
    fail("GH_ASSET_READ_FAILED", source, effect);
  } finally {
    reader.releaseLock();
  }
}
function imageMime(bytes: Buffer): "image/png" | "image/jpeg" | undefined {
  const safe = (width: number, height: number) =>
    width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000;
  if (
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    safe(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  ) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      const kind = bytes.toString("ascii", offset + 4, offset + 8);
      if (kind === "acTL" || offset + size + 12 > bytes.length) return undefined;
      if (kind === "IDAT") return "image/png";
      offset += size + 12;
    }
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 255) return undefined;
      while (bytes[offset] === 255) offset++;
      const marker = bytes.at(offset++);
      if (offset + 2 > bytes.length || marker === 218 || marker === 217) break;
      if (
        marker === 216 ||
        marker === 1 ||
        (marker !== undefined && marker >= 208 && marker <= 215)
      )
        continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return undefined;
      if (
        (marker === 192 || marker === 194) &&
        length >= 8 &&
        safe(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
      )
        return "image/jpeg";
      offset += length;
    }
  }
  return undefined;
}

/** Upload/read release assets through ordinary resource tools, preserving original bytes.
 * Only draft releases upload without explicit approval. Signed CDN redirects never
 * receive App credentials, and uncertain uploads are never automatically repeated.
 */
export class GithubAssets {
  readonly #fetch: typeof fetch;
  readonly #coordinator?: GithubRequestCoordinator;
  constructor(
    readonly credentials: GithubCredentialsProvider,
    readonly client: (cwd: string) => Promise<GithubRestReader & Pick<GithubClient, "coordinator">>,
    options: { fetcher?: typeof fetch; coordinator?: GithubRequestCoordinator } = {},
  ) {
    this.#fetch = options.fetcher ?? fetch;
    this.#coordinator = options.coordinator;
  }

  /** Recognize canonical asset reads and explicit release upload actions only. */
  owns(address: GithubAddress): boolean {
    return (
      address.parameters.size === 0 &&
      ((assetId(address) !== undefined && !address.facet) ||
        (releaseId(address) !== undefined && (!address.facet || address.facet === "schema")))
    );
  }

  /** Advertise the JSON action accepted by ordinary Write. No bytes enter chat. */
  readSchema(address: GithubAddress): string {
    if (!this.owns(address) || releaseId(address) === undefined)
      fail("GH_UNSUPPORTED_ACTION", address.source);
    return JSON.stringify(
      {
        source: address.source,
        tool: "write",
        input: {
          type: "object",
          required: ["file", "name"],
          additionalProperties: false,
          properties: {
            file: {
              type: "string",
              description: "Existing regular local file, relative to cwd or absolute; max 25 MiB",
            },
            name: { type: "string", minLength: 1, maxLength: 255 },
            label: { type: "string", maxLength: 255 },
            contentType: {
              type: "string",
              description: "MIME type; defaults to application/octet-stream",
            },
          },
        },
        approval: "Uploading to a published release requires approval for this exact action",
      },
      null,
      2,
    );
  }

  async #rest(
    address: GithubAddress,
    cwd: string,
    route: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      return (await (await this.client(cwd)).rest("GET", route, undefined, signal)).data;
    } catch (error) {
      check(signal, address.source);
      if (error instanceof GithubApiError || error instanceof ResourceError)
        throw githubResourceError(error, address.source, "GH_ASSET_METADATA_FAILED");
      fail("GH_ASSET_METADATA_FAILED", address.source);
    }
  }
  async #token(
    cwd: string,
    signal: AbortSignal,
    source: string,
    url: string,
  ): Promise<{
    token: string;
    owner: string;
    coordinator: GithubRequestCoordinator;
    signal: AbortSignal;
  }> {
    try {
      check(signal, source);
      const credentials = await abortable(this.credentials(cwd), signal, source);
      signal = credentials.signal ? AbortSignal.any([signal, credentials.signal]) : signal;
      check(signal, source);
      const coordinator = this.#coordinator ?? (await this.client(cwd)).coordinator;
      if (credentials.quotaOwner) await coordinator.check(credentials.quotaOwner, url);
      await abortable(credentials.initialize(signal), signal, source);
      const token = (await abortable(credentials.getToken(signal), signal, source)).token;
      if (!token || /[\r\n]/.test(token)) fail("GH_AUTH_FAILED", source);
      check(signal, source);
      return {
        token,
        owner: credentials.quotaOwner ?? `user:${credentials.identity.login.toLowerCase()}`,
        coordinator,
        signal,
      };
    } catch (error) {
      check(signal, source);
      throw githubResourceError(error, source, "GH_AUTH_FAILED");
    }
  }

  async #rateFailure(
    response: Response,
    coordinator: GithubRequestCoordinator,
    owner: string,
    url: string,
    signal: AbortSignal,
    source: string,
  ): Promise<void> {
    let data: unknown;
    if (response.status === 403 && !isGithubRateLimitResponse(response.status, response.headers)) {
      // Inspect only a bounded denial body to distinguish secondary limits from permissions.
      try {
        data = JSON.parse(
          Buffer.from(
            await responseBytes(response, 64 * 1024, signal, source, "not-applied"),
          ).toString("utf8"),
        );
      } catch {
        check(signal, source);
      }
    }
    if (isGithubRateLimitResponse(response.status, response.headers, data)) {
      await coordinator.observe(owner, url, response, data);
      throw new ResourceError("GH_RATE_LIMITED", source, "not-applied", {
        metadata: { rateLimit: rateLimitInfoFromHeaders(response.headers, Date.now(), true) },
      });
    }
  }

  /** Upload once, then verify the API asset identity and byte count before returning a receipt. */
  async upload(
    address: GithubAddress,
    content: string,
    cwd: string,
    caller?: AbortSignal,
    approve: GithubApproval = async () => false,
  ): Promise<GithubReceipt> {
    const id = releaseId(address);
    if (!this.owns(address) || address.facet || id === undefined)
      fail("GH_UNSUPPORTED_ACTION", address.source);
    let signal = boundedSignal(caller);
    check(signal, address.source);
    const input = uploadInput(content, address.source);
    const bytes = await localBytes(path.resolve(cwd, input.file), address.source, signal);
    const release = record(
      await this.#rest(
        address,
        cwd,
        `/repos/${address.owner}/${address.repo}/releases/${id}`,
        signal,
      ),
      address.source,
    );
    if (release.id !== id || typeof release.draft !== "boolean")
      fail("GH_ASSET_IDENTITY_MISMATCH", address.source);
    const raw =
      typeof release.upload_url === "string"
        ? release.upload_url.replace(/\{\?name,label\}$/, "")
        : undefined;
    const url = trustedUrl(raw, address.source, "GH_INVALID_UPLOAD_URL");
    if (
      url.origin !== uploadOrigin ||
      url.search ||
      url.pathname.toLowerCase() !==
        `/repos/${address.owner}/${address.repo}/releases/${id}/assets`.toLowerCase()
    )
      fail("GH_INVALID_UPLOAD_URL", address.source);
    if (
      !release.draft &&
      !(await abortable(approve(address.source, "upload release asset"), signal, address.source))
    )
      fail("GH_APPROVAL_REQUIRED", address.source);
    url.searchParams.set("name", input.name);
    if (input.label !== undefined) url.searchParams.set("label", input.label);
    const {
      token,
      owner,
      coordinator,
      signal: active,
    } = await this.#token(cwd, signal, address.source, url.href);
    signal = active;
    let response: Response;
    try {
      check(signal, address.source);
      response = await coordinator.fetch(
        owner,
        url.href,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            Authorization: "Bearer " + token,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            "Content-Type": input.contentType ?? "application/octet-stream",
            "Content-Length": String(bytes.length),
          },
          body: new Uint8Array(bytes),
          signal,
        },
        { fetcher: this.#fetch },
      );
      check(signal, address.source, "unknown");
    } catch (error) {
      const safe = githubResourceError(error, address.source, "GH_ASSET_UPLOAD_FAILED");
      if (safe.code !== "GH_ASSET_UPLOAD_FAILED") throw safe;
      check(signal, address.source, "unknown");
      fail("GH_ASSET_UPLOAD_FAILED", address.source, "unknown");
    }
    if (response.status !== 201) {
      await this.#rateFailure(response, coordinator, owner, url.href, signal, address.source);
      void response.body?.cancel().catch(() => undefined);
      const effect = response.status >= 400 && response.status < 500 ? "not-applied" : "unknown";
      fail(
        response.status === 401
          ? "GH_UNAUTHORIZED"
          : response.status === 403
            ? "GH_FORBIDDEN"
            : response.status === 429
              ? "GH_RATE_LIMITED"
              : "GH_ASSET_UPLOAD_FAILED",
        address.source,
        effect,
      );
    }
    let uploaded: Record<string, unknown>;
    try {
      uploaded = record(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await responseBytes(response, 2 * 1024 * 1024, signal, address.source, "unknown"),
          ),
        ),
        address.source,
        "unknown",
      );
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      fail("GH_ASSET_UPLOAD_UNVERIFIED", address.source, "unknown");
    }
    if (!Number.isSafeInteger(uploaded.id) || Number(uploaded.id) <= 0)
      fail("GH_ASSET_UPLOAD_UNVERIFIED", address.source, "unknown");
    const uploadedId = Number(uploaded.id);
    let verified: AssetMetadata;
    try {
      const received = metadata(uploaded, address, uploadedId, "unknown");
      verified = metadata(
        await this.#rest(address, cwd, assetRoute(address, uploadedId), signal),
        address,
        uploadedId,
        "unknown",
      );
      if (
        received.name !== input.name ||
        received.size !== bytes.length ||
        verified.name !== received.name ||
        verified.size !== bytes.length
      )
        fail("GH_ASSET_UPLOAD_UNVERIFIED", address.source, "unknown");
    } catch (error) {
      throw new ResourceError("GH_ASSET_UPLOAD_UNVERIFIED", address.source, "unknown", {
        metadata: githubResourceError(error, address.source, "GH_ASSET_UPLOAD_UNVERIFIED").metadata,
      });
    }
    return {
      source: githubSource(address, `releases/assets/${uploadedId}`),
      id: String(uploadedId),
      effect: "applied",
      ...(verified.url ? { url: verified.url } : {}),
    };
  }

  async #download(
    address: GithubAddress,
    cwd: string,
    caller?: AbortSignal,
  ): Promise<{ metadata: AssetMetadata; bytes: Buffer }> {
    let signal = boundedSignal(caller);
    check(signal, address.source);
    const id = assetId(address);
    if (id === undefined) fail("GH_UNSUPPORTED_RESOURCE", address.source);
    const data = metadata(
      await this.#rest(address, cwd, assetRoute(address, id), signal),
      address,
      id,
    );
    let url = new URL(apiOrigin + assetRoute(address, id));
    const {
      token,
      owner,
      coordinator,
      signal: active,
    } = await this.#token(cwd, signal, address.source, url.href);
    signal = active;
    for (let redirects = 0; ; redirects++) {
      check(signal, address.source);
      let response: Response;
      try {
        response = await coordinator.fetch(
          owner,
          url.href,
          {
            method: "GET",
            redirect: "manual",
            headers: {
              Accept: "application/octet-stream",
              ...(url.origin === apiOrigin
                ? { Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2026-03-10" }
                : {}),
            },
            signal,
          },
          { fetcher: this.#fetch },
        );
        check(signal, address.source);
      } catch (error) {
        const safe = githubResourceError(error, address.source, "GH_ASSET_READ_FAILED");
        if (safe.code !== "GH_ASSET_READ_FAILED") throw safe;
        check(signal, address.source);
        throw safe;
      }
      if (redirectStatuses.has(response.status)) {
        void response.body?.cancel().catch(() => undefined);
        if (redirects >= 3) fail("GH_ASSET_REDIRECT_LIMIT", address.source);
        const location = response.headers.get("location");
        if (!location || location.includes("\\")) fail("GH_INVALID_DOWNLOAD_URL", address.source);
        let redirected: URL;
        try {
          redirected = new URL(location, url);
        } catch {
          fail("GH_INVALID_DOWNLOAD_URL", address.source);
        }
        const next = trustedUrl(redirected.href, address.source, "GH_INVALID_DOWNLOAD_URL");
        if (
          !cdnOrigins.has(next.origin) &&
          !(
            next.origin === apiOrigin &&
            !next.search &&
            next.pathname.toLowerCase() === assetRoute(address, id).toLowerCase()
          )
        )
          fail("GH_INVALID_DOWNLOAD_URL", address.source);
        url = next;
        continue;
      }
      if (response.status !== 200) {
        await this.#rateFailure(response, coordinator, owner, url.href, signal, address.source);
        void response.body?.cancel().catch(() => undefined);
        fail("GH_ASSET_READ_FAILED", address.source);
      }
      const bytes = await responseBytes(
        response,
        maximumBytes,
        signal,
        address.source,
        "not-applied",
      );
      if (bytes.length !== data.size) fail("GH_ASSET_SIZE_MISMATCH", address.source);
      return { metadata: data, bytes };
    }
  }

  /** Resolve only canonical asset IDs. Upload schemas/actions are handled by ordinary Write. */
  resolver(): ResourceResolver {
    return {
      id: "github-assets",
      tryResolve: async (source, context) => {
        let address: GithubAddress | undefined;
        try {
          address = parseGithubAddress(source);
        } catch {
          return {
            kind: "failed",
            error: new ResourceError("GH_INVALID_URI", source, "not-applied"),
          };
        }
        if (!address || !this.owns(address) || assetId(address) === undefined)
          return { kind: "not-handled" };
        let snapshot: Promise<{ metadata: AssetMetadata; bytes: Buffer }> | undefined;
        const load = (signal?: AbortSignal) => {
          if (signal?.aborted) fail("GH_CANCELLED", address.source);
          return (snapshot ??= this.#download(address, context.cwd, signal));
        };
        return {
          kind: "resolved",
          resource: {
            source: address.source,
            readBytes: async (offset, limit, operation) => {
              const { bytes } = await load(operation.signal ?? context.signal);
              const start = Math.min(
                bytes.length,
                Math.max(0, offset < 0 ? bytes.length + offset : offset),
              );
              const end = start + Math.min(limit ?? bytes.length, bytes.length - start);
              return {
                bytes: Uint8Array.from(bytes.subarray(start, end)),
                byteOffset: start,
                totalBytes: bytes.length,
              };
            },
            read: async (operation): Promise<AgentContent> => {
              const signal = operation.signal ?? context.signal;
              const { bytes, metadata: data } = await load(signal);
              const header = `# GitHub release asset\nResource: ${address.source}\nName: ${data.name}\nContent type: ${data.contentType}\nSize: ${data.size} bytes\nOriginal bytes: raw:${address.source}`;
              const mime = imageMime(bytes);
              if (mime) {
                try {
                  const { resizeImage } = await import("@earendil-works/pi-coding-agent");
                  const converted = await resizeImage(bytes, mime, {
                    maxWidth: 1200,
                    maxHeight: 1200,
                    maxBytes: 4 * 1024 * 1024,
                  });
                  if (signal?.aborted) fail("GH_CANCELLED", address.source);
                  if (
                    converted &&
                    ["image/png", "image/jpeg"].includes(converted.mimeType) &&
                    converted.data.length <= 6 * 1024 * 1024
                  )
                    return [
                      { type: "text", text: header },
                      { type: "image", data: converted.data, mimeType: converted.mimeType },
                    ];
                } catch {
                  if (signal?.aborted) fail("GH_CANCELLED", address.source);
                }
              }
              let text: string | undefined;
              if (
                !bytes.subarray(0, 2).equals(Buffer.from("PK")) &&
                !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
              ) {
                try {
                  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                  if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoded))
                    text = decoded;
                } catch {
                  /* Binary bytes are not text. */
                }
              }
              return [
                {
                  type: "text",
                  text:
                    header +
                    "\n\n" +
                    (text ??
                      "This binary/archive format is not extracted. Use the raw resource for original bytes. No PDF extraction, OCR or archive expansion was performed."),
                },
              ];
            },
          },
        };
      },
    };
  }
}
