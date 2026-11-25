import { asRecord, asArrayOfUnknown, isUnknownArray, type InputRecord } from "./types.ts";
import { isConnectionFailure } from "./lib/connection-failure.ts";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { authorizationHeader, type NativeTokenProvider } from "./app-token.ts";
import {
  LinearRateLimitError,
  rateLimitInfoFromError,
  rejectRateLimit,
  type RateLimitInfo,
  type RateLimitObserver,
} from "./rate-limit.ts";

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
type Effect = "applied" | "not-applied" | "unknown";
export interface UploadInput {
  cwd: string;
  file: string;
  workspace: string;
  issue?: string;
  title?: string;
  contentType?: string;
  signal?: AbortSignal;
}
export interface UploadReceipt {
  workspace: string;
  upload: Effect;
  filename: string;
  size: number;
  sha256: string;
  assetUrl?: string;
  error?: string;
  rateLimit?: string;
  attachment?: { effect: Effect; id?: string; url?: string; error?: string; rateLimit?: string };
}
export interface StorageClient {
  upload(input: UploadInput): Promise<UploadReceipt>;
  download(input: {
    workspace: string;
    url: string;
    output: string;
    signal?: AbortSignal;
  }): Promise<{ size: number; sha256: string }>;
}
class StorageFailure extends Error {
  readonly code: string;
  readonly effect: Effect;
  readonly rateLimit?: RateLimitInfo;
  constructor(code: string, effect: Effect = "not-applied", rateLimit?: RateLimitInfo) {
    super(code);
    this.code = code;
    this.effect = effect;
    if (rateLimit) this.rateLimit = Object.freeze(rateLimit);
  }
}
function object(value: unknown): InputRecord {
  const record = asRecord(value);
  if (!record) throw new StorageFailure("LINEAR_INVALID_RESPONSE");
  return record;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new StorageFailure("LINEAR_INVALID_RESPONSE");
  return value;
}
/** Only documented private storage URLs may receive the native API authorization. */
export function privateAssetUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StorageFailure("LINEAR_INVALID_ASSET_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "uploads.linear.app" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/"
  )
    throw new StorageFailure("LINEAR_INVALID_ASSET_URL");
  return url.href;
}
function checkedWorkspace(workspace: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(workspace)) throw new StorageFailure("LINEAR_INVALID_WORKSPACE");
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function knownFailure(error: unknown, effect: Effect): StorageFailure | undefined {
  if (error instanceof StorageFailure) return error;
  if (error instanceof LinearRateLimitError || isConnectionFailure(error))
    return new StorageFailure(error.message, effect, rateLimitInfoFromError(error));
  return undefined;
}
function failure(
  error: unknown,
  fallback: string,
): { error: string; effect: Effect; rateLimit?: string } {
  const known = knownFailure(error, "unknown");
  const rateLimit = rateLimitInfoFromError(known);
  return {
    error: known?.code ?? fallback,
    effect: known?.effect ?? "unknown",
    ...(rateLimit ? { rateLimit: JSON.stringify(rateLimit) } : {}),
  };
}

interface StorageOptions {
  tokenProvider: NativeTokenProvider;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  onRateLimit?: RateLimitObserver;
}
/** Native storage operations reuse the existing app provider without requesting new scopes. */
export class LinearStorageClient implements StorageClient {
  private readonly options: StorageOptions;
  constructor(options: StorageOptions) {
    this.options = options;
  }
  private async rateLimited(response: Response, effect: Effect, observe = true): Promise<never> {
    try {
      return await rejectRateLimit(
        response.headers,
        observe ? this.options.onRateLimit : undefined,
      );
    } catch (error) {
      const outcome =
        knownFailure(error, effect) ?? new StorageFailure("LINEAR_GRAPHQL_FAILED", effect);
      try {
        if (!response.bodyUsed) await response.body?.cancel();
      } catch {
        Object.defineProperty(outcome, "cause", {
          value: new Error("LINEAR_RESPONSE_CLEANUP_FAILED"),
        });
      }
      throw outcome;
    }
  }
  private async request(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
    mutation = false,
  ): Promise<InputRecord> {
    signal?.throwIfAborted();
    let token: string;
    try {
      token = await authorizationHeader(this.options.tokenProvider, false, "storage");
    } catch (error) {
      throw new StorageFailure(
        isConnectionFailure(error) ? error.message : "LINEAR_GRAPHQL_AUTH_REQUIRED",
      );
    }
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(
        this.options.endpoint ?? "https://api.linear.app/graphql",
        {
          method: "POST",
          headers: { authorization: token, "content-type": "application/json" },
          body: JSON.stringify({ query, variables }),
          signal,
          redirect: "error",
        },
      );
    } catch (error) {
      const effect = mutation ? "unknown" : "not-applied";
      throw knownFailure(error, effect) ?? new StorageFailure("LINEAR_GRAPHQL_FAILED", effect);
    }
    if (response.status === 401) throw new StorageFailure("LINEAR_GRAPHQL_AUTH_REQUIRED");
    if (response.status === 403) throw new StorageFailure("LINEAR_PERMISSION_DENIED");
    if (response.status === 429) return this.rateLimited(response, "not-applied");
    try {
      const payload = object(await response.json());
      const errors = asArrayOfUnknown(payload.errors);
      if (errors?.length) {
        const codes = new Set(errors.map((error) => asRecord(asRecord(error)?.extensions)?.code));
        const code = codes.has("FORBIDDEN")
          ? "LINEAR_PERMISSION_DENIED"
          : codes.has("UNAUTHENTICATED")
            ? "LINEAR_GRAPHQL_AUTH_REQUIRED"
            : codes.has("RATELIMITED") || codes.has("RATE_LIMITED")
              ? "LINEAR_RATE_LIMITED"
              : "LINEAR_GRAPHQL_FAILED";
        if (code === "LINEAR_RATE_LIMITED")
          return await this.rateLimited(response, mutation ? "unknown" : "not-applied");
        throw new StorageFailure(code, mutation ? "unknown" : "not-applied");
      }
      if (!response.ok)
        throw new StorageFailure("LINEAR_GRAPHQL_FAILED", mutation ? "unknown" : "not-applied");
      return object(payload.data);
    } catch (error) {
      if (error instanceof StorageFailure) {
        if (mutation && error.code === "LINEAR_INVALID_RESPONSE")
          throw new StorageFailure(error.code, "unknown");
        throw error;
      }
      const effect = mutation ? "unknown" : "not-applied";
      throw knownFailure(error, effect) ?? new StorageFailure("LINEAR_INVALID_RESPONSE", effect);
    }
  }
  private async verify(
    workspace: string,
    issue?: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    checkedWorkspace(workspace);
    if (issue !== undefined && !/^[A-Z][A-Z0-9]*-\d+$/u.test(issue))
      throw new StorageFailure("LINEAR_INVALID_ISSUE");
    const data = await this.request(
      `query StorageScope${issue ? "($issue: String!)" : ""} { organization { urlKey } ${issue ? "issue(id: $issue) { id identifier url }" : ""} }`,
      issue ? { issue } : {},
      signal,
    );
    if (object(data.organization).urlKey !== workspace)
      throw new StorageFailure("LINEAR_IDENTITY_MISMATCH");
    if (!issue) return undefined;
    const row = object(data.issue);
    const url = new URL(text(row.url));
    if (
      row.identifier !== issue ||
      url.origin !== "https://linear.app" ||
      !url.pathname.startsWith(`/${workspace}/issue/${issue}/`)
    )
      throw new StorageFailure("LINEAR_IDENTITY_MISMATCH");
    return text(row.id);
  }
  /** Preserve upload and optional attachment effects separately; never replay a mutation. */
  async upload(input: UploadInput): Promise<UploadReceipt> {
    input = {
      ...input,
      signal: AbortSignal.any([
        AbortSignal.timeout(120_000),
        ...(input.signal ? [input.signal] : []),
      ]),
    };
    input.signal?.throwIfAborted();
    checkedWorkspace(input.workspace);
    const filename = path.basename(input.file);
    if (!filename || Buffer.byteLength(filename) > 255 || /\p{Cc}/u.test(filename))
      throw new StorageFailure("LINEAR_INVALID_FILENAME");
    const contentType =
      input.contentType ??
      {
        ".pdf": "application/pdf",
        ".zip": "application/zip",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".txt": "text/plain",
        ".md": "text/markdown",
      }[path.extname(filename).toLowerCase()] ??
      "application/octet-stream";
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(contentType))
      throw new StorageFailure("LINEAR_INVALID_CONTENT_TYPE");
    if (
      input.title !== undefined &&
      (!input.title.trim() || input.title.length > 1000 || /\p{Cc}/u.test(input.title))
    )
      throw new StorageFailure("LINEAR_INVALID_TITLE");
    const handle = await open(
      path.resolve(input.cwd, input.file),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Uint8Array;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_ASSET_BYTES)
        throw new StorageFailure("LINEAR_FILE_UNSUPPORTED_OR_TOO_LARGE");
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        input.signal?.throwIfAborted();
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_ASSET_BYTES - size + 1));
        const result = await handle.read(chunk, 0, chunk.length, size);
        if (result.bytesRead === 0) break;
        size += result.bytesRead;
        if (size > MAX_ASSET_BYTES)
          throw new StorageFailure("LINEAR_FILE_UNSUPPORTED_OR_TOO_LARGE");
        chunks.push(chunk.subarray(0, result.bytesRead));
      }
      bytes = Buffer.concat(chunks, size);
      const after = await handle.stat();
      if (
        bytes.length > MAX_ASSET_BYTES ||
        bytes.length !== before.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.size !== after.size
      )
        throw new StorageFailure("LINEAR_LOCAL_FILE_CHANGED");
    } finally {
      await handle.close();
    }
    const issueId = await this.verify(input.workspace, input.issue, input.signal);
    const base: UploadReceipt = {
      workspace: input.workspace,
      upload: "not-applied",
      filename,
      size: bytes.length,
      sha256: hash(bytes),
    };
    let upload: InputRecord;
    try {
      const data = await this.request(
        "mutation Upload($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size, makePublic: false) { success uploadFile { uploadUrl assetUrl headers { key value } } } }",
        { contentType, filename, size: bytes.length },
        input.signal,
        true,
      );
      const payload = object(data.fileUpload);
      if (payload.success !== true) throw new StorageFailure("LINEAR_UPLOAD_RESERVATION_FAILED");
      upload = object(payload.uploadFile);
      base.assetUrl = privateAssetUrl(text(upload.assetUrl));
    } catch (error) {
      const outcome = failure(error, "LINEAR_UPLOAD_RESERVATION_FAILED");
      return {
        ...base,
        error: outcome.error,
        ...(outcome.rateLimit ? { rateLimit: outcome.rateLimit } : {}),
      };
    }
    try {
      const url = new URL(text(upload.uploadUrl));
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.port ||
        /^(?:localhost|127\.|\[?::1\]?)/iu.test(url.hostname)
      )
        throw new StorageFailure("LINEAR_INVALID_UPLOAD_URL");
      if (!isUnknownArray(upload.headers)) throw new StorageFailure("LINEAR_INVALID_RESPONSE");
      const headers = new Headers({
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000",
      });
      for (const entry of upload.headers)
        headers.set(text(object(entry).key), text(object(entry).value));
      input.signal?.throwIfAborted();
      // Use only the upload headers designated by Linear, never the GraphQL bearer header.
      const response = await (this.options.fetchImpl ?? fetch)(url.href, {
        method: "PUT",
        headers,
        body: Uint8Array.from(bytes),
        signal: input.signal,
        redirect: "error",
      });
      if (response.status === 429) return await this.rateLimited(response, "unknown", false);
      if (!response.ok) throw new StorageFailure("LINEAR_UPLOAD_PUT_FAILED", "unknown");
      base.upload = "applied";
    } catch (error) {
      const outcome = failure(error, "LINEAR_UPLOAD_PUT_FAILED");
      return {
        ...base,
        upload: outcome.effect,
        error: outcome.error,
        ...(outcome.rateLimit ? { rateLimit: outcome.rateLimit } : {}),
      };
    }
    if (!issueId) return base;
    let acknowledged = false;
    try {
      const data = await this.request(
        "mutation Attach($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success attachment { id url } } }",
        { input: { issueId, title: input.title ?? filename, url: base.assetUrl } },
        input.signal,
        true,
      );
      acknowledged = true;
      const payload = object(data.attachmentCreate);
      if (payload.success !== true) throw new StorageFailure("LINEAR_ATTACHMENT_FAILED", "unknown");
      const attachment = object(payload.attachment);
      if (attachment.url !== base.assetUrl)
        throw new StorageFailure("LINEAR_INVALID_RESPONSE", "unknown");
      return {
        ...base,
        attachment: { effect: "applied", id: text(attachment.id), url: text(attachment.url) },
      };
    } catch (error) {
      const outcome = failure(error, "LINEAR_ATTACHMENT_FAILED");
      return {
        ...base,
        attachment: {
          effect: acknowledged ? "unknown" : outcome.effect,
          error: outcome.error,
          ...(outcome.rateLimit ? { rateLimit: outcome.rateLimit } : {}),
        },
      };
    }
  }
  /** Download only the documented private host; refuse redirects before sending credentials elsewhere. */
  async download(input: {
    workspace: string;
    url: string;
    output: string;
    signal?: AbortSignal;
  }): Promise<{ size: number; sha256: string }> {
    input = {
      ...input,
      signal: AbortSignal.any([
        AbortSignal.timeout(120_000),
        ...(input.signal ? [input.signal] : []),
      ]),
    };
    const url = privateAssetUrl(input.url);
    await this.verify(input.workspace, undefined, input.signal);
    let token: string;
    try {
      token = await authorizationHeader(this.options.tokenProvider, false, "storage");
    } catch (error) {
      throw new StorageFailure(
        isConnectionFailure(error) ? error.message : "LINEAR_GRAPHQL_AUTH_REQUIRED",
      );
    }
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, {
        headers: { authorization: token },
        signal: input.signal,
        redirect: "error",
      });
    } catch (error) {
      throw knownFailure(error, "not-applied") ?? new StorageFailure("LINEAR_ASSET_READ_FAILED");
    }
    if (response.status === 401) throw new StorageFailure("LINEAR_GRAPHQL_AUTH_REQUIRED");
    if (response.status === 403) throw new StorageFailure("LINEAR_PERMISSION_DENIED");
    if (response.status === 429) return this.rateLimited(response, "not-applied", false);
    if (!response.ok || !response.body) throw new StorageFailure("LINEAR_ASSET_READ_FAILED");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        input.signal?.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > MAX_ASSET_BYTES) throw new StorageFailure("LINEAR_ASSET_TOO_LARGE");
        chunks.push(chunk.value);
      }
    } catch (error) {
      const known = knownFailure(error, "not-applied");
      if (known) throw known;
      throw new StorageFailure("LINEAR_ASSET_READ_FAILED");
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = Buffer.concat(chunks, size);
    await writeFile(input.output, bytes, { flag: "wx", mode: 0o600, signal: input.signal });
    return { size, sha256: hash(bytes) };
  }
}
