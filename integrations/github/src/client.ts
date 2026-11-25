import {
  GithubRateLimitError,
  isGithubRateLimitResponse,
  rateLimitInfoFromHeaders,
  safeRateLimitInfo,
  type GithubRateLimitInfo,
} from "./rate-limit.ts";
import {
  GithubNotSentError,
  type GithubRequestCoordinator,
  githubRequestCoordinator,
} from "./request-coordinator.ts";

const apiOrigin = "https://api.github.com";
const maximumJsonBytes = 2 * 1024 * 1024;
const maximumBinaryBytes = 25 * 1024 * 1024;
const requestTimeoutMs = 20_000;
const methods = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
// GitHub's runner network reference names these log/artifact download hosts:
// https://docs.github.com/en/actions/reference/runners/github-hosted-runners
const downloadOrigins = new Set([
  "https://codeload.github.com",
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
  "https://results-receiver.actions.githubusercontent.com",
]);
type Effect = "not-applied" | "unknown";

/** Selected connection credentials stay inside the HTTP boundary, never in tool results. */
export interface GithubCredentials {
  initialize(signal?: AbortSignal): Promise<void>;
  getToken(signal?: AbortSignal): Promise<{ token: string; expiresAt: number }>;
  readonly identity: { login: string; name: string; email: string };
  /** Non-secret upstream quota owner, independent of local profile IDs. */
  readonly quotaOwner?: string;
  readonly signal?: AbortSignal;
}

/** Optional request metadata; caller-supplied authorization and arbitrary headers are not accepted. */
export interface GithubRequestOptions {
  readonly accept?: string;
  readonly operationName?: string;
}

/** Original response bytes and safe metadata, with no redirect URLs or authentication headers. */
export interface GithubResponse {
  readonly status: number;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly next?: string;
}

/** Safe failure information. Unknown effects must be inspected, never replayed automatically. */
export class GithubApiError extends Error {
  readonly code: string;
  readonly effect: Effect;
  readonly status?: number;
  readonly retryAfter?: string;
  readonly metadata?: { readonly rateLimit: GithubRateLimitInfo };

  constructor(
    code: string,
    effect: Effect,
    status?: number,
    retryAfter?: string,
    rateLimit?: GithubRateLimitInfo,
  ) {
    super(code);
    this.name = "GithubApiError";
    this.code = code;
    this.effect = effect;
    this.status = status;
    this.retryAfter = retryAfter;
    const safe = safeRateLimitInfo(rateLimit);
    if (safe) this.metadata = Object.freeze({ rateLimit: safe });
  }
}

function apiUrl(route: string): string {
  if (
    typeof route !== "string" ||
    route.includes("\\") ||
    !(route.startsWith("/") || route.startsWith(apiOrigin))
  )
    throw new GithubApiError("GH_INVALID_ROUTE", "not-applied");
  let url: URL;
  try {
    url = new URL(route, apiOrigin);
  } catch {
    throw new GithubApiError("GH_INVALID_ROUTE", "not-applied");
  }
  if (
    url.origin !== apiOrigin ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) =>
      ["access_token", "client_secret", "token"].includes(key.toLowerCase()),
    )
  )
    throw new GithubApiError("GH_INVALID_ROUTE", "not-applied");
  return url.href;
}

function retryAfter(headers: Headers): string | undefined {
  const value = headers.get("retry-after");
  if (!value || value.length > 100) return undefined;
  if (/^\d{1,6}$/.test(value)) return value;
  if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toUTCString();
  }
  return undefined;
}

function nextPage(headers: Headers, effect: Effect): string | undefined {
  const link = headers.get("link");
  if (!link) return undefined;
  if (link.length > 16_384) throw new GithubApiError("GH_INVALID_PAGINATION", effect);
  for (const entry of link.split(/,(?=\s*<)/)) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"(?:\s*;[^\r\n]*)?\s*$/.exec(entry);
    if (!match) continue;
    const [, target, relation] = match;
    if (!relation.split(/\s+/).includes("next")) continue;
    try {
      if (!target.startsWith(apiOrigin)) throw new Error();
      return apiUrl(target);
    } catch {
      throw new GithubApiError("GH_INVALID_PAGINATION", effect);
    }
  }
  return undefined;
}

function cancellationCode(signal: AbortSignal): string {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? "GH_TIMEOUT"
    : "GH_CANCELLED";
}

/** Wait for shared initialization or a body read without losing this caller's cancellation. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readBytes(
  response: Response,
  signal: AbortSignal,
  effect: Effect,
  maximumBytes: number,
): Promise<Uint8Array> {
  const advertised = response.headers.get("content-length");
  if (advertised && /^\d+$/.test(advertised) && Number(advertised) > maximumBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new GithubApiError("GH_RESPONSE_TOO_LARGE", effect);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      if (length + chunk.value.byteLength > maximumBytes)
        throw new GithubApiError("GH_RESPONSE_TOO_LARGE", effect);
      chunks.push(chunk.value);
      length += chunk.value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    // Stream cancellation itself can stall. It must not postpone the bounded failure.
    void reader.cancel().catch(() => undefined);
    if (error instanceof GithubApiError) throw error;
    throw new GithubApiError(
      signal.aborted ? cancellationCode(signal) : "GH_INVALID_RESPONSE",
      effect,
    );
  } finally {
    reader.releaseLock();
  }
}

function parseJson(bytes: Uint8Array, effect: Effect): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GithubApiError("GH_INVALID_RESPONSE", effect);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function encodeJson(value: unknown): string | undefined {
  return JSON.stringify(value);
}

function requestOptions(value: unknown): GithubRequestOptions {
  if (!isRecord(value)) throw new GithubApiError("GH_INVALID_INPUT", "not-applied");
  if (Object.keys(value).some((key) => !["accept", "operationName"].includes(key)))
    throw new GithubApiError("GH_INVALID_INPUT", "not-applied");
  if (
    value.accept !== undefined &&
    (typeof value.accept !== "string" ||
      value.accept.length > 256 ||
      !/^(?:\*|[A-Za-z0-9!#$&^_.+-]+)\/(?:\*|[A-Za-z0-9!#$&^_.+-]+)$/.test(value.accept))
  )
    throw new GithubApiError("GH_INVALID_INPUT", "not-applied");
  if (
    value.operationName !== undefined &&
    (typeof value.operationName !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.operationName))
  )
    throw new GithubApiError("GH_INVALID_INPUT", "not-applied");
  return {
    ...(value.accept === undefined ? {} : { accept: value.accept }),
    ...(value.operationName === undefined ? {} : { operationName: value.operationName }),
  };
}

function isGraphqlRead(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const query = (body as Record<string, unknown>).query;
  // A mutation always needs this literal GraphQL keyword. A false positive is safe:
  // comments/strings containing "mutation" conservatively leave the effect unknown.
  return typeof query === "string" && !!query.trim() && !/\bmutation\b/.test(query);
}

function isRead(method: string, url: string, body: unknown): boolean {
  const target = new URL(url);
  if (target.pathname === "/graphql") {
    if (method === "POST") return isGraphqlRead(body);
    if (method === "GET") return isGraphqlRead({ query: target.searchParams.get("query") });
    return method === "HEAD" || method === "OPTIONS";
  }
  return ["GET", "HEAD", "OPTIONS"].includes(method);
}

function allowsDownload(url: string): boolean {
  return /^\/repos\/[^/]+\/[^/]+\/(?:actions\/(?:runs\/\d+\/(?:attempts\/\d+\/)?logs|jobs\/\d+\/logs|artifacts\/\d+\/(?:zip|tar))|(?:zipball|tarball)(?:\/.*)?|releases\/assets\/\d+)$/.test(
    new URL(url).pathname,
  );
}

function redirectTarget(raw: string | null, current: string, download: boolean): string {
  if (!raw || raw.includes("\\")) throw new GithubApiError("GH_UNTRUSTED_REDIRECT", "not-applied");
  let target: URL;
  try {
    target = new URL(raw, current);
  } catch {
    throw new GithubApiError("GH_UNTRUSTED_REDIRECT", "not-applied");
  }
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.port ||
    target.hash
  )
    throw new GithubApiError("GH_UNTRUSTED_REDIRECT", "not-applied");
  const trustedDownload =
    downloadOrigins.has(target.origin) ||
    /^[a-z0-9][a-z0-9-]*\.blob\.core\.windows\.net$/.test(target.hostname);
  if (target.origin === apiOrigin && new URL(current).origin === apiOrigin) {
    if (!isRead("GET", target.href, undefined))
      throw new GithubApiError("GH_UNTRUSTED_REDIRECT", "not-applied");
    try {
      return apiUrl(target.href);
    } catch {
      throw new GithubApiError("GH_UNTRUSTED_REDIRECT", "not-applied");
    }
  }
  if (download && trustedDownload) return target.href;
  throw new GithubApiError("GH_UNTRUSTED_REDIRECT", "not-applied");
}

function responseLimit(type: string): number {
  return type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("xml") ||
    type.includes("javascript") ||
    type.includes("diff") ||
    type.includes("patch") ||
    !type
    ? maximumJsonBytes
    : maximumBinaryBytes;
}

/** A bounded REST/GraphQL client authenticated as one captured GitHub connection. */
export class GithubClient {
  readonly #credentials: GithubCredentials;
  readonly #fetch: typeof fetch;
  #initializing?: Promise<void>;
  #initialized = false;

  readonly coordinator: GithubRequestCoordinator;
  constructor(
    credentials: GithubCredentials,
    options: { fetcher?: typeof fetch; coordinator?: GithubRequestCoordinator } = {},
  ) {
    this.#credentials = credentials;
    this.#fetch = options.fetcher ?? fetch;
    this.coordinator = options.coordinator ?? githubRequestCoordinator;
  }

  /** Verified user or bot identity. Requests initialize it lazily. */
  get identity(): GithubCredentials["identity"] {
    try {
      return this.#credentials.identity;
    } catch {
      throw new GithubApiError("GH_AUTH_FAILED", "not-applied");
    }
  }

  /** Make one REST request. A trusted next link is returned, not fetched. */
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- callers can declare the schema of their own REST endpoint
  async rest<T = unknown>(
    method: string,
    route: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ data: T; next?: string }> {
    const readOnly = method === "GET" || method === "HEAD" || method === "OPTIONS";
    return (await this.#json(method, route, body, signal, readOnly)) as { data: T; next?: string };
  }

  /** Make one GraphQL operation; partial data/errors never look like a successful mutation. */
  async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (typeof query !== "string" || !query.trim() || !isRecord(variables))
      throw new GithubApiError("GH_INVALID_INPUT", "not-applied");
    const readOnly = isGraphqlRead({ query, variables });
    const effect = readOnly ? "not-applied" : "unknown";
    const { data } = await this.#json("POST", "/graphql", { query, variables }, signal, readOnly);
    if (!isRecord(data)) throw new GithubApiError("GH_INVALID_RESPONSE", effect);
    if (data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length > 0))
      throw new GithubApiError("GH_GRAPHQL_ERROR", effect);
    if (data.data === undefined || data.data === null)
      throw new GithubApiError("GH_INVALID_RESPONSE", effect);
    return data.data as T;
  }

  /** Send an arbitrary App API request and retain its original bytes. No mutation is retried.
   * Accept is a media type, not arbitrary headers. operationName applies only to POST /graphql.
   * Only GET follows trusted API redirects or credential-free GitHub download redirects.
   * Text/JSON is capped at 2 MiB, binary at 25 MiB, and the whole request at 20 seconds.
   */
  async request(
    method: string,
    route: string,
    body?: unknown,
    signal?: AbortSignal,
    options: GithubRequestOptions = {},
  ): Promise<GithubResponse> {
    const validated = requestOptions(options);
    const url = apiUrl(route);
    if (validated.operationName !== undefined) {
      if (
        method !== "POST" ||
        new URL(url).pathname !== "/graphql" ||
        !body ||
        typeof body !== "object" ||
        Array.isArray(body)
      )
        throw new GithubApiError("GH_INVALID_INPUT", "not-applied");
      body = { ...body, operationName: validated.operationName };
    }
    return this.#transport(method, url, body, signal, isRead(method, url, body), validated, true);
  }

  async #json(
    method: string,
    route: string,
    body: unknown,
    signal: AbortSignal | undefined,
    readOnly: boolean,
  ): Promise<{ data: unknown; next?: string }> {
    const response = await this.#transport(method, route, body, signal, readOnly, {}, false);
    const data =
      response.status === 204 || response.status === 205 || method === "HEAD"
        ? undefined
        : parseJson(response.bytes, readOnly ? "not-applied" : "unknown");
    return { data, ...(response.next ? { next: response.next } : {}) };
  }

  async #observe(
    owner: string,
    url: string,
    response: Response,
    data: unknown,
    effect: Effect,
  ): Promise<void> {
    try {
      await this.coordinator.observe(owner, url, response, data);
    } catch {
      // Observation is after dispatch: persistence failure cannot prove a mutation was not applied.
      throw new GithubApiError(
        "GH_RATE_STATE_UNSAFE",
        effect,
        response.status,
        undefined,
        rateLimitInfoFromHeaders(response.headers, Date.now(), true),
      );
    }
  }
  readonly #reads = new Map<
    string,
    { promise: Promise<GithubResponse>; controller: AbortController; readers: number }
  >();
  #readEpoch = 0;

  async #transport(
    method: string,
    route: string,
    body: unknown,
    caller: AbortSignal | undefined,
    readOnly: boolean,
    options: GithubRequestOptions,
    followDownloads: boolean,
  ): Promise<GithubResponse> {
    if (!readOnly) {
      this.#readEpoch++;
      this.#reads.clear();
    }
    if (method !== "GET" || body !== undefined)
      return this.#send(method, route, body, caller, readOnly, options, followDownloads);
    const key = JSON.stringify([
      this.#readEpoch,
      apiUrl(route),
      options.accept ?? "application/vnd.github+json",
      followDownloads,
    ]);
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    if (signal.aborted) throw new GithubApiError(cancellationCode(signal), "not-applied");
    let entry = this.#reads.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = {
        controller,
        readers: 0,
        promise: this.#send(
          method,
          route,
          body,
          controller.signal,
          readOnly,
          options,
          followDownloads,
        ),
      };
      this.#reads.set(key, entry);
      const owned = entry;
      const retire = () => {
        if (this.#reads.get(key) === owned) this.#reads.delete(key);
      };
      void entry.promise.then(retire, retire);
    }
    entry.readers++;
    try {
      const response = await abortable(entry.promise, signal);
      return { ...response, bytes: response.bytes.slice() };
    } catch (error) {
      if (isAborted(signal)) throw new GithubApiError(cancellationCode(signal), "not-applied");
      throw error;
    } finally {
      if (--entry.readers === 0) {
        if (this.#reads.get(key) === entry) this.#reads.delete(key);
        entry.controller.abort();
      }
    }
  }

  async #send(
    method: string,
    route: string,
    body: unknown,
    caller: AbortSignal | undefined,
    readOnly: boolean,
    options: GithubRequestOptions,
    followDownloads: boolean,
  ): Promise<GithubResponse> {
    if (!methods.has(method)) throw new GithubApiError("GH_INVALID_METHOD", "not-applied");
    const initialUrl = apiUrl(route);
    let encoded: string | undefined;
    if (body !== undefined) {
      if (method === "GET" || method === "HEAD")
        throw new GithubApiError("GH_INVALID_INPUT", "not-applied");
      try {
        encoded = encodeJson(body);
      } catch {
        throw new GithubApiError("GH_INVALID_INPUT", "not-applied");
      }
      if (typeof encoded !== "string" || Buffer.byteLength(encoded) > maximumJsonBytes)
        throw new GithubApiError("GH_INVALID_INPUT", "not-applied");
    }
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = AbortSignal.any([
      timeout,
      ...(caller ? [caller] : []),
      ...(this.#credentials.signal ? [this.#credentials.signal] : []),
    ]);
    let token: string;
    try {
      signal.throwIfAborted();
      if (this.#credentials.quotaOwner)
        await this.coordinator.check(this.#credentials.quotaOwner, initialUrl);
      if (!this.#initialized) {
        this.#initializing ??= this.#credentials
          .initialize()
          .then(() => {
            this.#initialized = true;
          })
          .finally(() => {
            this.#initializing = undefined;
          });
        await abortable(this.#initializing, signal);
      }
      token = (await abortable(this.#credentials.getToken(signal), signal)).token;
      if (!token || /[\r\n]/.test(token)) throw new Error();
      signal.throwIfAborted();
    } catch (error) {
      if (error instanceof GithubRateLimitError)
        throw new GithubApiError(error.code, "not-applied", undefined, undefined, error.rateLimit);
      if (error instanceof GithubNotSentError) throw new GithubApiError(error.code, "not-applied");
      throw new GithubApiError(
        signal.aborted ? cancellationCode(signal) : "GH_AUTH_FAILED",
        "not-applied",
      );
    }
    const effect: Effect = readOnly ? "not-applied" : "unknown";
    const owner = this.#credentials.quotaOwner ?? `user:${this.identity.login.toLowerCase()}`;
    let url = initialUrl;
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      try {
        response = await this.coordinator.fetch(
          owner,
          url,
          {
            method,
            redirect: followDownloads ? "manual" : "error",
            headers: {
              ...(new URL(url).origin === apiOrigin ? { Authorization: "Bearer " + token } : {}),
              Accept: options.accept ?? "application/vnd.github+json",
              ...(new URL(url).origin === apiOrigin
                ? { "X-GitHub-Api-Version": "2026-03-10" }
                : {}),
              ...(encoded === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(encoded === undefined ? {} : { body: encoded }),
            signal,
          },
          { fetcher: this.#fetch, readOnly },
        );
      } catch (error) {
        if (error instanceof GithubRateLimitError)
          throw new GithubApiError(
            error.code,
            "not-applied",
            undefined,
            undefined,
            error.rateLimit,
          );
        if (error instanceof GithubNotSentError)
          throw new GithubApiError(error.code, "not-applied");
        throw new GithubApiError(
          signal.aborted ? cancellationCode(signal) : "GH_REQUEST_FAILED",
          effect,
        );
      }
      if (
        !(followDownloads && readOnly && method === "GET" && redirectStatuses.has(response.status))
      )
        break;
      void response.body?.cancel().catch(() => undefined);
      if (redirects >= 5) throw new GithubApiError("GH_TOO_MANY_REDIRECTS", effect);
      url = redirectTarget(response.headers.get("location"), url, allowsDownload(initialUrl));
    }
    if (!response.ok) {
      const commitRoute = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)$/u.exec(
        new URL(initialUrl).pathname,
      )?.[1];
      if (method === "GET" && response.status === 422 && commitRoute !== undefined) {
        const bytes = await readBytes(response, signal, "not-applied", 64 * 1024);
        let missingCommit = false;
        try {
          const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          missingCommit =
            !!data &&
            typeof data === "object" &&
            "message" in data &&
            data.message === `No commit found for SHA: ${decodeURIComponent(commitRoute)}`;
        } catch {
          /* Other validation failures keep their HTTP error; never expose server text. */
        }
        if (missingCommit) throw new GithubApiError("GH_NOT_FOUND", "not-applied", 422);
      }
      let failureData: unknown;
      if (
        response.status === 403 &&
        !isGithubRateLimitResponse(response.status, response.headers)
      ) {
        try {
          failureData = parseJson(
            await readBytes(response, signal, "not-applied", 64 * 1024),
            "not-applied",
          );
        } catch {
          if (signal.aborted)
            throw new GithubApiError(
              cancellationCode(signal),
              "not-applied",
            ); /* Optional, bounded classification data is never exposed. */
        }
      }
      const limited = isGithubRateLimitResponse(response.status, response.headers, failureData);
      if (limited && !isGithubRateLimitResponse(response.status, response.headers))
        await this.#observe(owner, url, response, failureData, "not-applied");
      void response.body?.cancel().catch(() => undefined);
      const code = limited
        ? "GH_RATE_LIMITED"
        : response.status === 401
          ? "GH_UNAUTHORIZED"
          : response.status === 403
            ? "GH_FORBIDDEN"
            : response.status === 404
              ? "GH_NOT_FOUND"
              : response.status >= 500
                ? "GH_SERVER_ERROR"
                : "GH_HTTP_ERROR";
      throw new GithubApiError(
        code,
        response.status >= 400 && response.status < 500 ? "not-applied" : effect,
        response.status,
        retryAfter(response.headers),
        limited ? rateLimitInfoFromHeaders(response.headers, Date.now(), true) : undefined,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    const bytes =
      response.status === 204 || response.status === 205 || method === "HEAD"
        ? new Uint8Array()
        : await readBytes(
            response,
            signal,
            effect,
            followDownloads ? responseLimit(contentType.toLowerCase()) : maximumJsonBytes,
          );
    const next = nextPage(response.headers, effect);
    if (
      contentType.length > 256 ||
      /[\r\n]/.test(contentType) ||
      contentType.includes(token) ||
      (followDownloads && Buffer.from(bytes).includes(Buffer.from(token))) ||
      next?.includes(token)
    )
      throw new GithubApiError("GH_CREDENTIAL_IN_RESPONSE", effect);
    if (new URL(initialUrl).pathname === "/graphql") {
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        /* Ordinary JSON validation retains its owning failure below. */
      }
      if (isGithubRateLimitResponse(response.status, response.headers, data)) {
        await this.#observe(owner, initialUrl, response, data, effect);
        throw new GithubApiError(
          "GH_RATE_LIMITED",
          effect,
          response.status,
          retryAfter(response.headers),
          rateLimitInfoFromHeaders(response.headers, Date.now(), true),
        );
      }
    }
    return { status: response.status, contentType, bytes, ...(next ? { next } : {}) };
  }
}
